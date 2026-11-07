// 윈도우 11 우클릭 첫 화면 메뉴 — IExplorerCommand 하나가 메뉴 한 줄.
// 패키지(AppxManifest.xml)가 확장자별로 어떤 CLSID를 보일지 정하고, 이 DLL은 고른 파일들을 PdfTool.exe에 넘긴다.
// 빌드: shell\build.cmd
#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <new>
#include <string>
#include <vector>

#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "user32.lib")

static HMODULE g_module = nullptr;
static long g_refs = 0;

enum Accept { ACCEPT_PDF, ACCEPT_HWP_ANY, ACCEPT_HWP_ONLY };

struct Verb {
    CLSID clsid;
    const wchar_t* title;
    const wchar_t* sw;  // PdfTool.exe 스위치
    Accept accept;
};

// AppxManifest.xml의 Clsid와 같아야 한다
static const Verb kVerbs[] = {
    { { 0xA41292F3, 0x2C01, 0x4035, { 0x8C, 0xBE, 0xDC, 0x5E, 0x61, 0x2C, 0x42, 0x8F } }, L"PDF 합치기", L"--merge", ACCEPT_PDF },
    { { 0xA6FA80FF, 0xD4D9, 0x4F58, { 0x83, 0x8B, 0xCF, 0xB5, 0xD8, 0x8A, 0x61, 0x3C } }, L"PDF로 변환", L"--hwp2pdf", ACCEPT_HWP_ANY },
    { { 0x640235A8, 0xA313, 0x4ADF, { 0x84, 0x6C, 0xF6, 0xFC, 0xDA, 0x51, 0x3A, 0xC1 } }, L"PDF로 변환해서 합치기", L"--hwpmerge", ACCEPT_HWP_ANY },
    { { 0x6233F6F7, 0xCD41, 0x403E, { 0x88, 0xE0, 0x59, 0xA2, 0xF2, 0x2E, 0x77, 0x7F } }, L"HWPX로 변환", L"--hwp2hwpx", ACCEPT_HWP_ONLY },
};

// 설치 폴더의 PdfTool.exe — DLL은 <설치 폴더>\resources\shellmenu\ 에 있다
static std::wstring ExePath() {
    wchar_t buf[MAX_PATH * 2];
    DWORD n = GetModuleFileNameW(g_module, buf, ARRAYSIZE(buf));
    if (!n || n >= ARRAYSIZE(buf)) return L"";
    PathRemoveFileSpecW(buf);
    std::wstring dir(buf);
    for (int up = 0; up < 3; up++) {
        std::wstring exe = dir + L"\\PdfTool.exe";
        if (GetFileAttributesW(exe.c_str()) != INVALID_FILE_ATTRIBUTES) return exe;
        size_t cut = dir.find_last_of(L'\\');
        if (cut == std::wstring::npos) break;
        dir.resize(cut);
    }
    return L"";
}

static bool Accepts(Accept a, const std::wstring& path) {
    const wchar_t* ext = PathFindExtensionW(path.c_str());
    switch (a) {
    case ACCEPT_PDF: return _wcsicmp(ext, L".pdf") == 0;
    case ACCEPT_HWP_ANY: return _wcsicmp(ext, L".hwp") == 0 || _wcsicmp(ext, L".hwpx") == 0;
    case ACCEPT_HWP_ONLY: return _wcsicmp(ext, L".hwp") == 0;
    }
    return false;
}

static std::vector<std::wstring> Paths(IShellItemArray* items) {
    std::vector<std::wstring> out;
    DWORD count = 0;
    if (!items || FAILED(items->GetCount(&count))) return out;
    for (DWORD i = 0; i < count; i++) {
        IShellItem* it = nullptr;
        if (FAILED(items->GetItemAt(i, &it))) continue;
        PWSTR p = nullptr;
        if (SUCCEEDED(it->GetDisplayName(SIGDN_FILESYSPATH, &p))) {
            out.emplace_back(p);
            CoTaskMemFree(p);
        }
        it->Release();
    }
    return out;
}

static void Launch(const std::wstring& cmd) {
    std::vector<wchar_t> line(cmd.begin(), cmd.end());
    line.push_back(0);
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {};
    if (CreateProcessW(nullptr, line.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
        // 앱 창이 앞으로 나올 수 있게
        AllowSetForegroundWindow(pi.dwProcessId);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
}

class Command : public IExplorerCommand {
public:
    explicit Command(const Verb& v) : verb_(v) { InterlockedIncrement(&g_refs); }
    ~Command() { InterlockedDecrement(&g_refs); }

    IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) {
        static const QITAB qit[] = { QITABENT(Command, IExplorerCommand), { 0 } };
        return QISearch(this, qit, riid, ppv);
    }
    IFACEMETHODIMP_(ULONG) AddRef() { return InterlockedIncrement(&ref_); }
    IFACEMETHODIMP_(ULONG) Release() {
        long r = InterlockedDecrement(&ref_);
        if (!r) delete this;
        return r;
    }

    IFACEMETHODIMP GetTitle(IShellItemArray*, LPWSTR* name) { return SHStrDupW(verb_.title, name); }
    IFACEMETHODIMP GetIcon(IShellItemArray*, LPWSTR* icon) {
        std::wstring s = ExePath() + L",0";
        return SHStrDupW(s.c_str(), icon);
    }
    IFACEMETHODIMP GetToolTip(IShellItemArray*, LPWSTR* tip) { *tip = nullptr; return E_NOTIMPL; }
    IFACEMETHODIMP GetCanonicalName(GUID* guid) { *guid = verb_.clsid; return S_OK; }
    IFACEMETHODIMP GetState(IShellItemArray* items, BOOL, EXPCMDSTATE* state) {
        // 섞어서 고르면(예: pdf와 hwp) 맞지 않는 메뉴는 숨긴다
        *state = ECS_ENABLED;
        auto paths = Paths(items);
        if (paths.empty()) { *state = ECS_HIDDEN; return S_OK; }
        for (auto& p : paths) if (!Accepts(verb_.accept, p)) { *state = ECS_HIDDEN; break; }
        return S_OK;
    }
    IFACEMETHODIMP Invoke(IShellItemArray* items, IBindCtx*) {
        std::wstring exe = ExePath();
        auto paths = Paths(items);
        if (paths.empty() || GetFileAttributesW(exe.c_str()) == INVALID_FILE_ATTRIBUTES) return S_OK;
        // 명령줄 길이 한도(32767자) 안에서 묶어 보낸다 — 넘치면 여러 번 실행, 앱이 첫 창으로 모은다
        const std::wstring head = L"\"" + exe + L"\" " + verb_.sw;
        std::wstring cmd = head;
        bool any = false;
        for (auto& p : paths) {
            if (!Accepts(verb_.accept, p)) continue;
            std::wstring arg = L" \"" + p + L"\"";
            if (any && cmd.size() + arg.size() > 30000) { Launch(cmd); cmd = head; }
            cmd += arg;
            any = true;
        }
        if (any) Launch(cmd);
        return S_OK;
    }
    IFACEMETHODIMP GetFlags(EXPCMDFLAGS* flags) { *flags = ECF_DEFAULT; return S_OK; }
    IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand** e) { *e = nullptr; return E_NOTIMPL; }

private:
    const Verb& verb_;
    long ref_ = 1;
};

class Factory : public IClassFactory {
public:
    explicit Factory(const Verb& v) : verb_(v) { InterlockedIncrement(&g_refs); }
    ~Factory() { InterlockedDecrement(&g_refs); }
    IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) {
        static const QITAB qit[] = { QITABENT(Factory, IClassFactory), { 0 } };
        return QISearch(this, qit, riid, ppv);
    }
    IFACEMETHODIMP_(ULONG) AddRef() { return InterlockedIncrement(&ref_); }
    IFACEMETHODIMP_(ULONG) Release() {
        long r = InterlockedDecrement(&ref_);
        if (!r) delete this;
        return r;
    }
    IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) {
        *ppv = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        Command* c = new (std::nothrow) Command(verb_);
        if (!c) return E_OUTOFMEMORY;
        HRESULT hr = c->QueryInterface(riid, ppv);
        c->Release();
        return hr;
    }
    IFACEMETHODIMP LockServer(BOOL lock) {
        if (lock) InterlockedIncrement(&g_refs); else InterlockedDecrement(&g_refs);
        return S_OK;
    }

private:
    const Verb& verb_;
    long ref_ = 1;
};

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv) {
    *ppv = nullptr;
    for (auto& v : kVerbs) {
        if (IsEqualCLSID(clsid, v.clsid)) {
            Factory* f = new (std::nothrow) Factory(v);
            if (!f) return E_OUTOFMEMORY;
            HRESULT hr = f->QueryInterface(riid, ppv);
            f->Release();
            return hr;
        }
    }
    return CLASS_E_CLASSNOTAVAILABLE;
}

STDAPI DllCanUnloadNow() { return g_refs == 0 ? S_OK : S_FALSE; }

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_module = module;
        DisableThreadLibraryCalls(module);
    }
    return TRUE;
}
