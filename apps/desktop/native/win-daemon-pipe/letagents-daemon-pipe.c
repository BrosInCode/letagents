/*
 * letagents-daemon-pipe.node: the client end of the supervisor daemon's
 * named pipe on Windows, opened so that the server end cannot act as this
 * process, and handed to Node only when the server end is this user's.
 *
 * libuv opens a client pipe with CreateFileW and no security quality of
 * service, so the default applies: SecurityImpersonation. Whatever process
 * holds the server end of the name can then call ImpersonateNamedPipeClient
 * and act as this user (with SeImpersonatePrivilege, a service account can
 * do so from another account). Node cannot pass other flags, so this addon
 * opens the pipe itself:
 *
 *   CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
 *               FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
 *
 * With SECURITY_IDENTIFICATION the server can read who the client is, but an
 * impersonation gives it a token it cannot open objects with.
 *
 * Before the handle is handed on, so before this process writes a byte, the
 * process that serves the pipe (GetNamedPipeServerProcessId) must run with
 * this process's user SID, enabled (not deny-only), in no AppContainer, with
 * no restricting SIDs and at an integrity level no lower than this
 * process's: a process that can read this user's files, as the daemon's
 * proof file, anyway. Anything else is refused and the handle is closed
 * unused. (The id names the process that created the instance; were that
 * process gone and its id reused, SECURITY_IDENTIFICATION and the proof
 * handshake still hold.)
 *
 * The handle becomes a C runtime descriptor through the host's own
 * uv_open_osfhandle, so libuv (in node.exe or Electron) owns it with the
 * descriptor table it reads, and `new net.Socket({ fd })` wraps it. A
 * descriptor this module must give back is closed through the host's
 * uv_fs_close. Descriptors 0 to 2 are first filled with NUL where a process
 * has none (a GUI process may not): libuv treats those as standard streams
 * and never closes their handle.
 *
 * It links only kernel32, advapi32 and the static C runtime. It has no
 * import library for Node: N-API and uv_open_osfhandle are found in the host
 * executable (GetModuleHandleW(NULL)), which node.exe and Electron export.
 * If one is missing the module exports nothing and the caller refuses to
 * connect.
 *
 *   open(name) -> { fd, serverPid }
 *       name: "\\.\pipe\<letters, digits, '-' or '_'>". Throws an Error whose
 *       code is ENOENT (no such pipe), EBUSY (every instance is busy; try
 *       again), ERR_LETAGENTS_DAEMON_UNTRUSTED (the server end is not this
 *       user's, or the pipe denies this user), EINVAL or EIO (with winerror).
 *
 * Build: apps/desktop/native/win-daemon-pipe/build.mjs (MSVC, /MT /Brepro).
 */
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <stddef.h>
#include <stdint.h>

/* The N-API declarations this module uses (js_native_api.h, node_api.h). */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
#define NAPI_OK 0
#define NAPI_AUTO_LENGTH SIZE_MAX
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

typedef napi_status (*get_cb_info_fn)(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
typedef napi_status (*get_value_string_utf16_fn)(napi_env, napi_value, WCHAR *, size_t, size_t *);
typedef napi_status (*create_object_fn)(napi_env, napi_value *);
typedef napi_status (*create_int32_fn)(napi_env, int32_t, napi_value *);
typedef napi_status (*create_uint32_fn)(napi_env, uint32_t, napi_value *);
typedef napi_status (*create_string_utf8_fn)(napi_env, const char *, size_t, napi_value *);
typedef napi_status (*create_error_fn)(napi_env, napi_value, napi_value, napi_value *);
typedef napi_status (*set_named_property_fn)(napi_env, napi_value, const char *, napi_value);
typedef napi_status (*throw_fn)(napi_env, napi_value);
typedef napi_status (*create_function_fn)(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
typedef napi_status (*get_uv_event_loop_fn)(napi_env, void **);
typedef int (*uv_open_osfhandle_fn)(HANDLE);
typedef int (*uv_fs_close_fn)(void *, void *, int, void *);
typedef void (*uv_fs_req_cleanup_fn)(void *);

static struct {
    get_cb_info_fn get_cb_info;
    get_value_string_utf16_fn get_value_string_utf16;
    create_object_fn create_object;
    create_int32_fn create_int32;
    create_uint32_fn create_uint32;
    create_string_utf8_fn create_string_utf8;
    create_error_fn create_error;
    set_named_property_fn set_named_property;
    throw_fn throw_value;
    create_function_fn create_function;
    get_uv_event_loop_fn get_uv_event_loop;
    uv_open_osfhandle_fn uv_open_osfhandle;
    uv_fs_close_fn uv_fs_close;
    uv_fs_req_cleanup_fn uv_fs_req_cleanup;
} host;

#define PIPE_PREFIX L"\\\\.\\pipe\\"
#define PIPE_PREFIX_LENGTH 9
#define MAX_PIPE_NAME 256
#define UNTRUSTED "ERR_LETAGENTS_DAEMON_UNTRUSTED"

/* Resolve every host function, or none: a missing one leaves the module empty. */
static BOOL resolve_host(void) {
    HMODULE module = GetModuleHandleW(NULL);
    if (!module) return FALSE;
#define RESOLVE(field, type, name) \
    if (!(host.field = (type)GetProcAddress(module, name))) return FALSE
    RESOLVE(get_cb_info, get_cb_info_fn, "napi_get_cb_info");
    RESOLVE(get_value_string_utf16, get_value_string_utf16_fn, "napi_get_value_string_utf16");
    RESOLVE(create_object, create_object_fn, "napi_create_object");
    RESOLVE(create_int32, create_int32_fn, "napi_create_int32");
    RESOLVE(create_uint32, create_uint32_fn, "napi_create_uint32");
    RESOLVE(create_string_utf8, create_string_utf8_fn, "napi_create_string_utf8");
    RESOLVE(create_error, create_error_fn, "napi_create_error");
    RESOLVE(set_named_property, set_named_property_fn, "napi_set_named_property");
    RESOLVE(throw_value, throw_fn, "napi_throw");
    RESOLVE(create_function, create_function_fn, "napi_create_function");
    RESOLVE(get_uv_event_loop, get_uv_event_loop_fn, "napi_get_uv_event_loop");
    RESOLVE(uv_open_osfhandle, uv_open_osfhandle_fn, "uv_open_osfhandle");
    RESOLVE(uv_fs_close, uv_fs_close_fn, "uv_fs_close");
    RESOLVE(uv_fs_req_cleanup, uv_fs_req_cleanup_fn, "uv_fs_req_cleanup");
#undef RESOLVE
    return TRUE;
}

/*
 * Close a descriptor of the host's C runtime, and its handle, as libuv does:
 * a synchronous uv_fs_close. The request is opaque here; uv_fs_t is a few
 * hundred bytes in libuv 1.x, so 4 KiB of aligned, zeroed space holds it.
 */
static void close_descriptor(napi_env env, int fd) {
    union {
        BYTE bytes[4096];
        void *pointer;
        double number;
    } request;
    void *loop = NULL;
    if (host.get_uv_event_loop(env, &loop) != NAPI_OK || !loop) return;
    ZeroMemory(&request, sizeof(request));
    host.uv_fs_close(loop, &request, fd, NULL);
    host.uv_fs_req_cleanup(&request);
}

/* Fill descriptors 0 to 2 with NUL where they are free, once per process. */
static BOOL reserve_standard_descriptors(napi_env env) {
    static BOOL reserved = FALSE;
    int attempt;
    if (reserved) return TRUE;
    for (attempt = 0; attempt < 4; attempt++) {
        HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
        int fd;
        if (nul == INVALID_HANDLE_VALUE) return FALSE;
        fd = host.uv_open_osfhandle(nul);
        if (fd < 0) {
            CloseHandle(nul);
            return FALSE;
        }
        if (fd > 2) {
            /* The lowest free descriptor is above the standard ones: they are taken. */
            close_descriptor(env, fd);
            reserved = TRUE;
            return TRUE;
        }
    }
    return FALSE;
}

/* Throw an Error with `code` and `message`, and `winerror` when it is not 0. Returns NULL. */
static napi_value fail(napi_env env, const char *code, const char *message, DWORD winerror) {
    napi_value code_value, message_value, error;
    if (host.create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != NAPI_OK) return NULL;
    if (host.create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) != NAPI_OK) return NULL;
    if (host.create_error(env, code_value, message_value, &error) != NAPI_OK) return NULL;
    if (winerror) {
        napi_value number;
        if (host.create_uint32(env, (uint32_t)winerror, &number) == NAPI_OK) host.set_named_property(env, error, "winerror", number);
    }
    host.throw_value(env, error);
    return NULL;
}

/* "\\.\pipe\" then 1 to MAX_PIPE_NAME letters, digits, '-' or '_': no path a pipe name could leave by. */
static BOOL valid_pipe_name(const WCHAR *name, size_t length) {
    static const WCHAR prefix[] = PIPE_PREFIX;
    size_t index;
    if (length <= PIPE_PREFIX_LENGTH || length > PIPE_PREFIX_LENGTH + MAX_PIPE_NAME) return FALSE;
    for (index = 0; index < PIPE_PREFIX_LENGTH; index++) {
        WCHAR expected = prefix[index], actual = name[index];
        if (actual >= L'A' && actual <= L'Z') actual = (WCHAR)(actual - L'A' + L'a');
        if (actual != expected) return FALSE;
    }
    for (; index < length; index++) {
        WCHAR c = name[index];
        if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'-' || c == L'_')) return FALSE;
    }
    return TRUE;
}

/* TOKEN_USER, the integrity RID, and whether the token is an AppContainer or restricted. */
typedef struct {
    union {
        TOKEN_USER user;
        BYTE bytes[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
    } user;
    DWORD integrity;
    DWORD app_container;
    BOOL restricted;
} token_facts;

static BOOL read_token(HANDLE token, token_facts *facts) {
    union {
        TOKEN_MANDATORY_LABEL label;
        BYTE bytes[sizeof(TOKEN_MANDATORY_LABEL) + SECURITY_MAX_SID_SIZE];
    } label;
    DWORD size = 0;
    PUCHAR count;
    if (!GetTokenInformation(token, TokenUser, &facts->user, sizeof(facts->user), &size)) return FALSE;
    if (!GetTokenInformation(token, TokenIntegrityLevel, &label, sizeof(label), &size)) return FALSE;
    count = GetSidSubAuthorityCount(label.label.Label.Sid);
    if (!count || *count == 0) return FALSE;
    facts->integrity = *GetSidSubAuthority(label.label.Label.Sid, (DWORD)(*count - 1));
    if (!GetTokenInformation(token, TokenIsAppContainer, &facts->app_container, sizeof(facts->app_container), &size)) return FALSE;
    /* FALSE is also the answer on failure; only GetLastError tells them apart. */
    SetLastError(ERROR_SUCCESS);
    facts->restricted = IsTokenRestricted(token);
    if (!facts->restricted && GetLastError() != ERROR_SUCCESS) return FALSE;
    return TRUE;
}

/* NULL when the process `pid` may serve this process's pipe; else why not. */
static const char *refuse_server(ULONG pid) {
    HANDLE self_token = NULL, server = NULL, server_token = NULL;
    token_facts self, other;
    const char *refusal = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &self_token) || !read_token(self_token, &self)) {
        refusal = "this process cannot read its own token";
    } else if (!(server = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid))) {
        refusal = "the process serving the pipe cannot be opened, so it is not this user's";
    } else if (!OpenProcessToken(server, TOKEN_QUERY, &server_token) || !read_token(server_token, &other)) {
        refusal = "the token of the process serving the pipe cannot be read, so it is not this user's";
    } else if (!EqualSid(self.user.user.User.Sid, other.user.user.User.Sid)) {
        refusal = "the process serving the pipe runs as another user";
    } else if (other.user.user.User.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) {
        refusal = "the process serving the pipe has this user's SID for deny only";
    } else if (other.app_container) {
        refusal = "the process serving the pipe runs in an AppContainer";
    } else if (other.restricted) {
        refusal = "the process serving the pipe has a restricted token (restricting SIDs)";
    } else if (other.integrity < self.integrity) {
        refusal = "the process serving the pipe runs at a lower integrity level";
    }
    if (server_token) CloseHandle(server_token);
    if (server) CloseHandle(server);
    if (self_token) CloseHandle(self_token);
    return refusal;
}

static napi_value open_pipe(napi_env env, napi_callback_info info) {
    size_t argc = 1, length = 0;
    napi_value argv[1], result, fd_value, pid_value;
    WCHAR name[PIPE_PREFIX_LENGTH + MAX_PIPE_NAME + 1];
    HANDLE pipe;
    ULONG pid = 0;
    const char *refusal;
    int fd;

    if (!reserve_standard_descriptors(env)) return fail(env, "EIO", "Descriptors 0 to 2 could not be reserved.", GetLastError());
    if (host.get_cb_info(env, info, &argc, argv, NULL, NULL) != NAPI_OK || argc < 1) {
        return fail(env, "EINVAL", "open(name) needs a pipe name.", 0);
    }
    /* The length first: a longer name would be cut to fit the buffer. */
    if (host.get_value_string_utf16(env, argv[0], NULL, 0, &length) != NAPI_OK || length >= ARRAYSIZE(name)
        || host.get_value_string_utf16(env, argv[0], name, ARRAYSIZE(name), &length) != NAPI_OK
        || !valid_pipe_name(name, length)) {
        return fail(env, "EINVAL", "open(name) takes a pipe name \\\\.\\pipe\\<letters, digits, '-' or '_'>.", 0);
    }

    pipe = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
            return fail(env, "ENOENT", "No process serves the supervisor daemon pipe.", error);
        }
        if (error == ERROR_PIPE_BUSY) return fail(env, "EBUSY", "Every instance of the supervisor daemon pipe is busy.", error);
        if (error == ERROR_ACCESS_DENIED) {
            return fail(env, UNTRUSTED, "The supervisor daemon pipe denies this user, so another account holds it.", error);
        }
        return fail(env, "EIO", "The supervisor daemon pipe could not be opened.", error);
    }
    if (GetFileType(pipe) != FILE_TYPE_PIPE || !GetNamedPipeServerProcessId(pipe, &pid)) {
        DWORD error = GetLastError();
        CloseHandle(pipe);
        return fail(env, UNTRUSTED, "The supervisor daemon pipe has no server process to check.", error);
    }
    refusal = refuse_server(pid);
    if (refusal) {
        CloseHandle(pipe);
        return fail(env, UNTRUSTED, refusal, 0);
    }
    /* Everything that can fail before the descriptor exists is done first. */
    if (host.create_object(env, &result) != NAPI_OK
        || host.create_uint32(env, (uint32_t)pid, &pid_value) != NAPI_OK
        || host.set_named_property(env, result, "serverPid", pid_value) != NAPI_OK) {
        CloseHandle(pipe);
        return NULL;
    }
    fd = host.uv_open_osfhandle(pipe);
    if (fd < 0) {
        CloseHandle(pipe);
        return fail(env, "EMFILE", "The pipe handle could not get a file descriptor.", 0);
    }
    /* From here the descriptor owns the handle; the caller closes fd on any later failure. */
    if (host.create_int32(env, fd, &fd_value) != NAPI_OK || host.set_named_property(env, result, "fd", fd_value) != NAPI_OK) {
        close_descriptor(env, fd);
        return NULL;
    }
    return result;
}

__declspec(dllexport) int32_t node_api_module_get_api_version_v1(void) {
    return 8;
}

__declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    napi_value open;
    if (!resolve_host()) return NULL;
    if (host.create_function(env, "open", NAPI_AUTO_LENGTH, open_pipe, NULL, &open) != NAPI_OK) return NULL;
    if (host.set_named_property(env, exports, "open", open) != NAPI_OK) return NULL;
    return exports;
}
