// Memoria's isolated compatibility patch for SeaweedFS 4.51 (Apache-2.0).
// This file is copied into weed/s3api when building the pinned qualification image.
package s3api

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/seaweedfs/seaweedfs/weed/filer"
	"github.com/seaweedfs/seaweedfs/weed/pb/filer_pb"
	"github.com/seaweedfs/seaweedfs/weed/s3api/s3_constants"
)

// Keep the ordering already used by multipart completion: the first chunk's
// nanosecond timestamp, with a stable tie break and a fallback for inline parts.
// Concurrent uploads may race, but listing and completion must choose identically.
func memoriaPartTime(entry *filer_pb.Entry) int64 {
	if len(entry.Chunks) > 0 {
		return entry.Chunks[0].ModifiedTsNs
	}
	return entry.GetAttributes().GetMtime() * int64(time.Second)
}

func memoriaPartNewer(a, b *filer_pb.Entry) bool {
	if b == nil {
		return true
	}
	if at, bt := memoriaPartTime(a), memoriaPartTime(b); at != bt {
		return at > bt
	}
	return a.Name > b.Name
}

func memoriaPartNumber(entry *filer_pb.Entry) (int, bool) {
	if entry.IsDirectory || !strings.HasSuffix(entry.Name, multipartExt) {
		return 0, false
	}
	number, err := parsePartNumber(entry.Name)
	return number, err == nil && number >= 1 && number <= s3_constants.MaxS3MultipartParts
}

// A retry never adds another retained entry for a part. Memory is bounded by
// S3's 10,000 part numbers, independently of the number of physical retry files.
func memoriaRememberPart(current map[int]*filer_pb.Entry, entry *filer_pb.Entry) {
	if number, ok := memoriaPartNumber(entry); ok && memoriaPartNewer(entry, current[number]) {
		current[number] = entry
	}
}

func memoriaSortedParts(current map[int]*filer_pb.Entry) []*filer_pb.Entry {
	numbers := make([]int, 0, len(current))
	for n := range current {
		numbers = append(numbers, n)
	}
	sort.Ints(numbers)
	entries := make([]*filer_pb.Entry, 0, len(numbers))
	for _, n := range numbers {
		entries = append(entries, current[n])
	}
	return entries
}

func (s3a *S3ApiServer) memoriaListCurrentParts(directory string) ([]*filer_pb.Entry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var current map[int]*filer_pb.Entry
	err := listRetry(directory, func() error {
		// Reset on a transient retry; no entries from a failed attempt survive.
		current = make(map[int]*filer_pb.Entry)
		return filer_pb.List(ctx, s3a, directory, "", func(entry *filer_pb.Entry, _ bool) error {
			memoriaRememberPart(current, entry)
			return nil
		}, "", false, math.MaxInt32)
	})
	if err != nil {
		return nil, err
	}
	return memoriaSortedParts(current), nil
}

// Completion must exclude old ETags BEFORE matching the submitted manifest.
// Otherwise a client can finalize a superseded physical version after overwrite.
func memoriaCurrentAndSuperseded(entries []*filer_pb.Entry) ([]*filer_pb.Entry, []*filer_pb.Entry) {
	current := make(map[int]*filer_pb.Entry)
	for _, entry := range entries {
		memoriaRememberPart(current, entry)
	}
	var superseded []*filer_pb.Entry
	for _, entry := range entries {
		if n, ok := memoriaPartNumber(entry); ok && current[n] != entry {
			superseded = append(superseded, entry)
		}
	}
	return memoriaSortedParts(current), superseded
}

func memoriaFillPartsPage(output *ListPartsResult, input *s3.ListPartsInput, entries []*filer_pb.Entry) {
	limit := int(aws.Int64Value(input.MaxParts))
	if limit < 0 {
		limit = 0
	}
	if limit > 1000 {
		limit = 1000
	}
	output.MaxParts = aws.Int64(int64(limit))
	output.IsTruncated = aws.Bool(false)
	if limit == 0 {
		return
	}
	for _, entry := range entries {
		number, ok := memoriaPartNumber(entry)
		if !ok || int64(number) <= aws.Int64Value(input.PartNumberMarker) {
			continue
		}
		if len(output.Part) == limit {
			output.IsTruncated = aws.Bool(true)
			output.NextPartNumberMarker = output.Part[len(output.Part)-1].PartNumber
			return
		}
		part := &s3.Part{
			PartNumber:   aws.Int64(int64(number)),
			LastModified: aws.Time(time.Unix(entry.GetAttributes().GetMtime(), 0).UTC()),
			Size:         aws.Int64(int64(filer.FileSize(entry))),
			ETag:         aws.String(getEtagFromEntry(entry)),
		}
		if strings.EqualFold(string(entry.Extended[s3_constants.ExtChecksumAlgorithm]), "X-Amz-Checksum-Sha256") {
			part.ChecksumSHA256 = aws.String(string(entry.Extended[s3_constants.ExtChecksumValue]))
		}
		output.Part = append(output.Part, part)
	}
}
