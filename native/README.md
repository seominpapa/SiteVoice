# 외부 앱에 입력하는 보조 프로그램

`node native/build.mjs [arm64|x64]`로 빌드합니다. 결과는
`native/bin/<platform>-<arch>/voice-target[.exe]`에 생깁니다.
Mac은 Xcode Command Line Tools가 필요하며 Intel 보조 프로그램은 macOS 14
이상 대상입니다. Windows는 MSVC와 Windows SDK를 설치한 뒤 x64 Developer
Command Prompt에서 빌드합니다.

Main과 보조 프로그램은 표준 입출력에서 한 줄씩 순서대로 통신합니다.

| 요청 | 동작 |
| --- | --- |
| `PERMISSION` | 현재 프로세스의 권한 및 입력 API 상태 확인 |
| `REQUEST_PERMISSION` | macOS 권한 요청. Windows는 상태만 확인 |
| `SNAPSHOT` | 포커스된 앱·창·편집 요소 확인 및 이후 포커스 변경 감시 |
| `PASTE <base64>` | 스냅숏을 한 번 소비하여 UTF-8 텍스트(최대 512 KiB) 붙여넣기 단축키 발송 시도 |
| `RESET` | 저장한 입력 대상 초기화 |

응답은 `{"ok":true}` 또는 `{"ok":false,"reason":"..."}`입니다.
실패 코드는 `permission`, `target`, `changed`, `clipboard`, `input`, `invalid`입니다.
소유 중인 클립보드 복원에 실패하면 응답에 `"warning":"clipboard"`가 추가됩니다.
이후 다른 앱이 클립보드를 변경했다면 복원을 시도하지 않습니다.

macOS는 Accessibility의 앱·창·요소와 빈 선택 범위를 확인하고 대상 PID에
Cmd+V를 보냅니다. Windows는 전경 HWND와 UI Automation 요소, 빈 선택
범위와 프로세스 권한을 확인한 뒤 Ctrl+V를 SendInput으로 보냅니다. 두 경우
성공 응답은 단축키 발송까지를 뜻합니다. 비밀번호 칸, 선택된 텍스트, 확인할 수
없는 편집 요소, 보존할 수 없는 클립보드 형식이면 결과 창에서 복사합니다.

macOS는 최대 32 MiB의 읽을 수 있는 바이트 형식을 복사합니다. 파일
약속(promise) 형식은 제외합니다. Windows는 최대 32 MiB의 텍스트, HTML, RTF,
일반 이미지, 파일 목록 등 지원 형식만 복사합니다. 다른 형식이 하나라도
있으면 클립보드를 건드리지 않습니다. macOS API에 원자적 비교·쓰기 기능이
없어 소유권 확인과 쓰기 사이의 운영체제 수준 경합은 남습니다.

빌드 후 `node --test native/test.mjs`를 실행할 수 있습니다. 이 테스트는
외부 앱에 키를 보내지 않으며 macOS 클립보드 테스트는 테스트 전용 이름의
클립보드를 사용합니다. 자동 입력 자체의 확인은 OS별 별도 실기기 테스트입니다.
