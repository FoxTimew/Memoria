package s3api

import (
	"fmt"
	"slices"
	"testing"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/seaweedfs/seaweedfs/weed/pb/filer_pb"
	"github.com/seaweedfs/seaweedfs/weed/s3api/s3_constants"
	"github.com/seaweedfs/seaweedfs/weed/s3api/s3err"
)

func memoriaTestPart(name string, timestamp int64, size uint64, etag string) *filer_pb.Entry {
	e := partEntry(name, size)
	e.Chunks = []*filer_pb.FileChunk{{ModifiedTsNs: timestamp, Size: size}}
	e.Extended = map[string][]byte{
		s3_constants.ExtETagKey:           []byte(etag),
		s3_constants.ExtChecksumAlgorithm: []byte("X-Amz-Checksum-Sha256"),
		s3_constants.ExtChecksumValue:     []byte("planned-checksum"),
	}
	return e
}

func TestMemoriaListLatestRetryAndPagination(t *testing.T) {
	f := &fakePartsFiler{uploadEntry: uploadRecordEntry("u"), parts: []*filer_pb.Entry{
		memoriaTestPart("0001_z.part", 10, 5, "old"),
		memoriaTestPart("0001_a.part", 20, 9, "new"),
		memoriaTestPart("0002_z.part", 15, 6, "two"),
		memoriaTestPart("1000_z.part", 12, 7, "thousand"),
		memoriaTestPart("10000_z.part", 13, 8, "last"),
	}}
	s3a := newListPartsServer(t, f)
	input := listPartsInput("u")
	input.MaxParts = aws.Int64(1)
	var got []int64
	for page := 0; page < 5; page++ {
		out, code := s3a.listObjectParts(input)
		if code != s3err.ErrNone {
			t.Fatalf("list: %v", code)
		}
		got = append(got, partNumbers(out)...)
		if page == 0 {
			if aws.Int64Value(out.Part[0].Size) != 9 || aws.StringValue(out.Part[0].ETag) != `"new"` {
				t.Fatalf("old version returned: %+v", out.Part[0])
			}
			if aws.StringValue(out.Part[0].ChecksumSHA256) != "planned-checksum" {
				t.Fatal("checksum lost")
			}
		}
		if !aws.BoolValue(out.IsTruncated) {
			break
		}
		if out.NextPartNumberMarker == nil {
			t.Fatal("missing marker")
		}
		input.PartNumberMarker = out.NextPartNumberMarker
	}
	if !slices.Equal(got, []int64{1, 2, 1000, 10000}) {
		t.Fatalf("parts: %v", got)
	}
}

func TestMemoriaRetriesBoundMemoryAndStableWinner(t *testing.T) {
	current := make(map[int]*filer_pb.Entry)
	for i := 0; i < 25000; i++ {
		memoriaRememberPart(current, memoriaTestPart(fmt.Sprintf("0001_%08d.part", 25000-i), int64(i), 5, "etag"))
	}
	if len(current) != 1 || memoriaPartTime(current[1]) != 24999 {
		t.Fatal("retry count leaked into retained state")
	}
	memoriaRememberPart(current, partEntry("10001_invalid.part", 1))
	memoriaRememberPart(current, partEntry("0000_invalid.part", 1))
	if len(current) != 1 {
		t.Fatal("invalid part number retained")
	}
	a := memoriaTestPart("0001_a.part", 20, 5, "a")
	z := memoriaTestPart("0001_z.part", 20, 5, "z")
	for _, order := range [][]*filer_pb.Entry{{a, z}, {z, a}} {
		latest, discarded := memoriaCurrentAndSuperseded(order)
		if len(latest) != 1 || latest[0] != z || len(discarded) != 1 || discarded[0] != a {
			t.Fatal("tie is not deterministic")
		}
	}
}

func TestMemoriaCompleteCannotChooseSupersededETag(t *testing.T) {
	old := memoriaTestPart("0001_z.part", 10, 5, "old")
	newer := memoriaTestPart("0001_a.part", 20, 6, "new")
	current, removed := memoriaCurrentAndSuperseded([]*filer_pb.Entry{old, newer})
	if len(current) != 1 || current[0] != newer || len(removed) != 1 || removed[0] != old {
		t.Fatal("incorrect partition")
	}
	if match, _, _, _ := validateCompletePartETag(`"old"`, current[0]); match {
		t.Fatal("old ETag accepted")
	}
	if match, _, _, _ := validateCompletePartETag(`"new"`, current[0]); !match {
		t.Fatal("new ETag rejected")
	}
}
