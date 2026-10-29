// A hostile pipe server for daemon-pipe.windows.test.mjs. It takes a pipe
// name first, waits for one client, and records what it could do with it:
// impersonate it at once and after a read, the impersonation level it got,
// and whether that token opens a file. Never shipped.
//
//   pipe-squatter.exe squat <config>   serve as this process's own token
//   pipe-squatter.exe low <config>     start `squat` at low integrity, wait
//   pipe-squatter.exe denyonly <config>
//                                      start `squat` with this user's SID for
//                                      deny only (CreateRestrictedToken), wait
//
// <config> holds four lines: the pipe name, the report path, a file to open
// while impersonating, and a marker written once the pipe exists.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class PipeSquatter {
    const uint PIPE_ACCESS_DUPLEX = 3, FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
    const int ERROR_PIPE_CONNECTED = 535;
    const uint TOKEN_QUERY = 0x0008, TOKEN_DUPLICATE = 0x0002, TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_ADJUST_DEFAULT = 0x0080;
    const int TokenImpersonationLevel = 9, TokenIntegrityLevel = 25;

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, ref SECURITY_ATTRIBUTES sa);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ConnectNamedPipe(IntPtr pipe, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr file, byte[] buffer, uint size, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DisconnectNamedPipe(IntPtr pipe);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool ImpersonateNamedPipeClient(IntPtr pipe);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool RevertToSelf();
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenThreadToken(IntPtr thread, uint access, bool openAsSelf, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int value, int length, out int returned);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr sa, int level, int type, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref SID_AND_ATTRIBUTES label, int length);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSidW(string sid, out IntPtr result);
    [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, SID_AND_ATTRIBUTES[] disable,
        uint deleteCount, IntPtr delete, uint restrictCount, IntPtr restrict, out IntPtr result);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION information);

    static string Json(string value) {
        var text = new StringBuilder("\"");
        foreach (char c in value) {
            if (c == '"' || c == '\\') text.Append('\\').Append(c);
            else if (c < ' ') text.Append("\\u").Append(((int)c).ToString("x4"));
            else text.Append(c);
        }
        return text.Append('"').ToString();
    }

    /** Impersonate the client, read the level of the token that gives, and try to open `probe` with it. */
    static string Impersonate(IntPtr pipe, string probe) {
        if (!ImpersonateNamedPipeClient(pipe)) return "{\"ok\":false,\"error\":" + Marshal.GetLastWin32Error() + "}";
        int level = -1, levelError = 0, openError = 0;
        IntPtr token;
        if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, out token)) {
            int returned;
            if (!GetTokenInformation(token, TokenImpersonationLevel, out level, 4, out returned)) levelError = Marshal.GetLastWin32Error();
            CloseHandle(token);
        } else {
            levelError = Marshal.GetLastWin32Error();
        }
        IntPtr file = CreateFileW(probe, 0x80000000, 1, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (file == new IntPtr(-1)) openError = Marshal.GetLastWin32Error(); else CloseHandle(file);
        RevertToSelf();
        return "{\"ok\":true,\"level\":" + level + ",\"levelError\":" + levelError + ",\"openError\":" + openError + "}";
    }

    static void Report(string path, string json) {
        File.WriteAllText(path + ".partial", json);
        File.Move(path + ".partial", path);
    }

    static int Squat(string[] config) {
        string name = config[0], report = config[1], probe = config[2], ready = config[3];
        IntPtr descriptor;
        uint size;
        // Everyone may open it, as a hostile server would allow.
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:(A;;GA;;;WD)", 1, out descriptor, out size)) return 3;
        var attributes = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = descriptor };
        IntPtr pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE, 0, 1, 4096, 4096, 0, ref attributes);
        if (pipe == new IntPtr(-1)) {
            Report(report, "{\"created\":false,\"error\":" + Marshal.GetLastWin32Error() + "}");
            return 2;
        }
        File.WriteAllText(ready, "ready");
        bool connected = ConnectNamedPipe(pipe, IntPtr.Zero) || Marshal.GetLastWin32Error() == ERROR_PIPE_CONNECTED;
        // As an exploit would: impersonate at once, before the client wrote anything.
        string before = Impersonate(pipe, probe);
        byte[] buffer = new byte[4096];
        uint read = 0;
        int readError = 0;
        if (!ReadFile(pipe, buffer, (uint)buffer.Length, out read, IntPtr.Zero)) readError = Marshal.GetLastWin32Error();
        string after = read > 0 ? Impersonate(pipe, probe) : "null";
        Report(report, "{\"created\":true,\"connected\":" + (connected ? "true" : "false")
            + ",\"user\":" + Json(WindowsIdentity.GetCurrent().Name)
            + ",\"beforeRead\":" + before + ",\"bytesRead\":" + read + ",\"readError\":" + readError
            + ",\"text\":" + Json(Encoding.UTF8.GetString(buffer, 0, (int)read)) + ",\"afterRead\":" + after + "}");
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        return 0;
    }

    /** Start `squat <config>` as `primary`, and wait for it. */
    static int StartAs(IntPtr primary, string configPath) {
        string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
        PROCESS_INFORMATION started;
        var line = new StringBuilder("\"" + self + "\" squat \"" + configPath + "\"");
        if (!CreateProcessAsUserW(primary, self, line, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref startup, out started)) {
            Console.Error.WriteLine("CreateProcessAsUser failed: " + Marshal.GetLastWin32Error());
            return 14;
        }
        WaitForSingleObject(started.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(started.hProcess, out code);
        return (int)code;
    }

    /** Start `squat <config>` with this process's token lowered to low integrity. */
    static int Low(string configPath) {
        IntPtr token, primary, sid;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_QUERY, out token)) return 10;
        if (!DuplicateTokenEx(token, 0x02000000, IntPtr.Zero, 2, 1, out primary)) return 11;
        if (!ConvertStringSidToSidW("S-1-16-4096", out sid)) return 12;
        var label = new SID_AND_ATTRIBUTES { Sid = sid, Attributes = 0x20 };
        if (!SetTokenInformation(primary, TokenIntegrityLevel, ref label, Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)) + GetLengthSid(sid))) return 13;
        return StartAs(primary, configPath);
    }

    /** Start `squat <config>` with this user's SID for deny only: same user, same integrity, but it cannot open the user's files. */
    static int DenyOnly(string configPath) {
        IntPtr token, restricted, sid;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_QUERY, out token)) return 10;
        if (!ConvertStringSidToSidW(WindowsIdentity.GetCurrent().User.Value, out sid)) return 12;
        var disable = new[] { new SID_AND_ATTRIBUTES { Sid = sid, Attributes = 0 } };
        if (!CreateRestrictedToken(token, 0, 1, disable, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted)) return 15;
        return StartAs(restricted, configPath);
    }

    public static int Main(string[] args) {
        if (args.Length != 2) return 64;
        if (args[0] == "squat") return Squat(File.ReadAllLines(args[1]));
        if (args[0] == "low") return Low(args[1]);
        if (args[0] == "denyonly") return DenyOnly(args[1]);
        return 64;
    }
}
