// 첫 화면 메뉴 점검 도구: 탐색기처럼 패키지 COM을 만들어 제목·보임 여부를 읽고, --invoke면 실행까지 한다.
//   probe.exe [--invoke 번호] 파일...
#include <windows.h>
#include <shobjidl.h>
#include <shlobj.h>
#include <cstdio>
#include <vector>
#include <string>
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")

static const CLSID kIds[] = {
    { 0xA41292F3, 0x2C01, 0x4035, { 0x8C, 0xBE, 0xDC, 0x5E, 0x61, 0x2C, 0x42, 0x8F } },
    { 0xA6FA80FF, 0xD4D9, 0x4F58, { 0x83, 0x8B, 0xCF, 0xB5, 0xD8, 0x8A, 0x61, 0x3C } },
    { 0x640235A8, 0xA313, 0x4ADF, { 0x84, 0x6C, 0xF6, 0xFC, 0xDA, 0x51, 0x3A, 0xC1 } },
    { 0x6233F6F7, 0xCD41, 0x403E, { 0x88, 0xE0, 0x59, 0xA2, 0xF2, 0x2E, 0x77, 0x7F } },
};

int wmain(int argc, wchar_t** argv) {
    SetConsoleOutputCP(CP_UTF8);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    int invoke = -1, first = 1;
    if (argc > 2 && wcscmp(argv[1], L"--invoke") == 0) { invoke = _wtoi(argv[2]); first = 3; }
    std::vector<PIDLIST_ABSOLUTE> pidls;
    for (int i = first; i < argc; i++) {
        PIDLIST_ABSOLUTE p = nullptr;
        if (SUCCEEDED(SHParseDisplayName(argv[i], nullptr, &p, 0, nullptr))) pidls.push_back(p);
    }
    IShellItemArray* arr = nullptr;
    HRESULT hr = SHCreateShellItemArrayFromIDLists((UINT)pidls.size(), (PCIDLIST_ABSOLUTE_ARRAY)pidls.data(), &arr);
    if (FAILED(hr)) { printf("item array 실패 %08lx\n", hr); return 1; }
    for (int k = 0; k < 4; k++) {
        IExplorerCommand* cmd = nullptr;
        hr = CoCreateInstance(kIds[k], nullptr, CLSCTX_LOCAL_SERVER | CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&cmd));
        if (FAILED(hr)) { printf("[%d] 만들기 실패 %08lx\n", k, hr); continue; }
        LPWSTR title = nullptr, icon = nullptr;
        cmd->GetTitle(arr, &title);
        cmd->GetIcon(arr, &icon);
        EXPCMDSTATE st = 0;
        cmd->GetState(arr, FALSE, &st);
        char t[512] = {}, ic[1024] = {};
        WideCharToMultiByte(CP_UTF8, 0, title ? title : L"", -1, t, sizeof(t), nullptr, nullptr);
        WideCharToMultiByte(CP_UTF8, 0, icon ? icon : L"", -1, ic, sizeof(ic), nullptr, nullptr);
        printf("[%d] %s | %s | 아이콘 %s\n", k, t, st == ECS_HIDDEN ? "숨김" : "보임", ic);
        if (k == invoke) printf("    실행 결과 %08lx\n", cmd->Invoke(arr, nullptr));
        CoTaskMemFree(title); CoTaskMemFree(icon);
        cmd->Release();
    }
    arr->Release();
    return 0;
}
