#!/bin/sh
set -eu
printf '%s  %s\n' '316c9ef7d43bf7a90d6eefa269b2b4ef250992a44320c7c1c1466d3c788f6b08' '/upstream.tar.gz' | sha256sum -c -
mkdir /work/source
tar -xzf /upstream.tar.gz -C /work/source --strip-components=1
cd /work/source
git apply --check /patches/multipart.patch
git apply --whitespace=error /patches/multipart.patch
cp /patches/memoria_multipart.go /patches/memoria_multipart_test.go weed/s3api/
test -z "$(gofmt -l weed/s3api/memoria_multipart.go weed/s3api/memoria_multipart_test.go weed/s3api/filer_multipart.go)"
go test -p 2 -v -count=1 -timeout=5m ./weed/s3api > /work/go-tests.txt 2>&1 || { cat /work/go-tests.txt; exit 1; }
tail -n 3 /work/go-tests.txt
go build -p 2 -trimpath -buildvcs=false -ldflags '-buildid= -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=153ab668-memoria1' -o /work/weed ./weed
sha256sum /work/weed
