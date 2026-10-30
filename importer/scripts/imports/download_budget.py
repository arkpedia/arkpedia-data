"""Finish an enrichment batch before its runner deadline, preserving completed downloads."""
import http.client
import time


class BudgetExpired(RuntimeError):
    pass


class DownloadBudget:
    def __init__(self, seconds=600, *, clock=time.monotonic, sleep=time.sleep):
        self.clock, self.sleeper = clock, sleep
        self.deadline = clock() + seconds

    def remaining(self):
        return max(0, self.deadline - self.clock())

    def check(self):
        if self.remaining() <= 0:
            raise BudgetExpired('download batch budget reached')

    def timeout(self, preferred):
        self.check()
        return min(preferred, 20, self.remaining())

    def sleep(self, seconds):
        self.check()
        if seconds >= self.remaining():
            raise BudgetExpired('retry would exceed download batch budget')
        self.sleeper(seconds)

    def read(self, response):
        chunks = []
        expected = getattr(response, 'length', None)
        received = 0
        while True:
            self.check()
            # read1 returns available bytes instead of waiting to fill a whole chunk.
            # Check the deadline even if a slow server keeps its connection alive.
            chunk = response.read1(65536)
            if not chunk:
                if expected is not None and received < expected:
                    # HTTPResponse.read1 does not raise on a truncated Content-Length
                    # body the way read() does. Keep the importer's existing retry rule.
                    raise http.client.IncompleteRead(b''.join(chunks), expected - received)
                return b''.join(chunks)
            chunks.append(chunk)
            received += len(chunk)
