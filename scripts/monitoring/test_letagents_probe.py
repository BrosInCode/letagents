import importlib.util
import json
import queue
import shutil
import subprocess
import sys
import tempfile
import time
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("letagents_probe.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProbeTest(unittest.TestCase):
    def setUp(self):
        self.mode = "healthy"
        self.messages = queue.Queue()
        self.saved = None
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def json(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if test.mode == "database_down":
                    return self.json(503, {"error": "unavailable"})
                test.saved = {"id": "msg_1", "text": body["text"]}
                self.json(201, test.saved)
                test.messages.put(test.saved)

            def do_GET(self):
                if self.path.endswith("/stream"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    sync = {"room_id": "PRIVATE-ROOM", "gap": test.mode == "gap"}
                    self.wfile.write(("event: room_sync\ndata: " + json.dumps(sync) + "\n\n").encode())
                    self.wfile.flush()
                    if test.mode == "stream_closed":
                        return
                    try:
                        message = test.messages.get(timeout=1)
                    except queue.Empty:
                        return
                    if test.mode == "wrong_delivery":
                        message = {"id": "msg_other", "text": "old message"}
                    self.wfile.write(("data: " + json.dumps(message) + "\n\n").encode())
                    self.wfile.flush()
                else:
                    if test.mode == "trickling":
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        try:
                            for _ in range(200):
                                self.wfile.write(b" ")
                                self.wfile.flush()
                                time.sleep(.02)
                        except (BrokenPipeError, ConnectionResetError):
                            pass
                        return
                    message = test.saved if test.mode != "history_missing" else {}
                    self.json(200, {"message": message})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_requires_write_stream_and_history(self):
        result = module.probe(self.url, "PRIVATE-ROOM", .5)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["checks"], ["message_write", "live_delivery", "persisted_history"])

    def test_database_failure_does_not_report_up(self):
        self.mode = "database_down"
        with self.assertRaisesRegex(module.ProbeFailure, "message_write"):
            module.probe(self.url, "PRIVATE-ROOM", .5)

    def test_http_200_without_delivery_is_failure(self):
        self.mode = "stream_closed"
        with self.assertRaisesRegex(module.ProbeFailure, "live_delivery"):
            module.probe(self.url, "PRIVATE-ROOM", .5)

    def test_old_message_cannot_satisfy_probe(self):
        self.mode = "wrong_delivery"
        with self.assertRaisesRegex(module.ProbeFailure, "live_delivery"):
            module.probe(self.url, "PRIVATE-ROOM", .5)

    def test_missing_persisted_message_is_failure(self):
        self.mode = "history_missing"
        with self.assertRaisesRegex(module.ProbeFailure, "persisted_history"):
            module.probe(self.url, "PRIVATE-ROOM", .5)

    def test_gap_is_not_ready(self):
        self.mode = "gap"
        with self.assertRaisesRegex(module.ProbeFailure, "stream_setup"):
            module.probe(self.url, "PRIVATE-ROOM", .5)

    @unittest.skipUnless(shutil.which("timeout"), "GNU timeout is required on the monitor host")
    def test_process_deadline_bounds_trickling_response(self):
        self.mode = "trickling"
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory)/"config.json"
            config.write_text(json.dumps({"base_url": self.url, "room_id": "PRIVATE-ROOM", "timeout_seconds": .5}))
            started = time.monotonic()
            result = subprocess.run(["timeout", "--kill-after=2s", "1s", sys.executable, str(Path(module.__file__)), "--config", str(config)], capture_output=True, timeout=4)
            self.assertEqual(result.returncode, 124)
            self.assertLess(time.monotonic()-started, 4)

    def test_connection_failure_does_not_expose_room(self):
        with self.assertRaises(module.ProbeFailure) as error:
            module.probe("http://127.0.0.1:1", "PRIVATE-ROOM", .1)
        self.assertNotIn("PRIVATE-ROOM", str(error.exception))


if __name__ == "__main__":
    unittest.main()
