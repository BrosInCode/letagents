import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('watchdog-check.sh').resolve()


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.env = dict(os.environ, STATE_DIR=str(self.path), LETAGENTS_PROBE=str(self.path/'probe'), NTFY_URL='http://unused.invalid', PATH=str(self.path)+':'+os.environ['PATH'])
        self.tool('probe', 'echo "probe" >> "$STATE_DIR/calls"; echo \'{"status":"ok"}\'; exit "${PROBE_EXIT:-0}"')
        self.tool('curl', 'echo "notification" >> "$STATE_DIR/notifications"; exit "${NOTIFY_EXIT:-0}"')
        self.tool('sleep', 'exit 0')
        self.tool('timeout', 'test "$1" = "--kill-after=2s" && test "$2" = "30s" || exit 99; shift 2; exec "$@"')

    def tearDown(self):
        self.temp.cleanup()

    def tool(self, name, content):
        p=self.path/name
        p.write_text('#!/bin/sh\n'+content+'\n')
        p.chmod(0o700)

    def run_check(self):
        return subprocess.run(['bash','-c','source "$1"; check_letagents','bash',str(SCRIPT)],env=self.env,capture_output=True,text=True,timeout=5)

    def test_healthy_does_not_notify_every_run(self):
        self.assertEqual(self.run_check().returncode, 0)
        self.assertEqual((self.path/'letagents').read_text(), 'up\n')
        self.assertFalse((self.path/'notifications').exists())

    def test_failure_retries_and_notifies_once_then_recovers(self):
        self.env['PROBE_EXIT']='1'
        self.assertNotEqual(self.run_check().returncode, 0)
        self.assertEqual((self.path/'calls').read_text().splitlines(), ['probe','probe'])
        self.assertEqual((self.path/'letagents').read_text(), 'down\n')
        self.run_check()
        self.assertEqual(len((self.path/'notifications').read_text().splitlines()),1)
        self.env['PROBE_EXIT']='0'
        self.assertEqual(self.run_check().returncode, 0)
        self.assertEqual(len((self.path/'notifications').read_text().splitlines()),2)

    def test_failed_alert_is_retried_next_run(self):
        (self.path/'letagents').write_text('up\n')
        self.env.update(PROBE_EXIT='1',NOTIFY_EXIT='1')
        self.assertNotEqual(self.run_check().returncode,0)
        self.assertEqual((self.path/'letagents').read_text(),'up\n')
        self.env['NOTIFY_EXIT']='0'
        self.run_check()
        self.assertEqual((self.path/'letagents').read_text(),'down\n')
        self.assertEqual(len((self.path/'notifications').read_text().splitlines()),2)


if __name__ == '__main__':
    unittest.main()
