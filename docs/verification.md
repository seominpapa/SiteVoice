# VoiceInput 0.1.0 검증 기록

2026-11-21 · Apple Silicon macOS 26.7.1 · Electron 45.4.1

| 검사 | 결과 |
| --- | --- |
| `npm run typecheck` | Main·Preload·Renderer 통과 |
| `npm test` | 단위·통합 29개 통과 |
| `npm run test:coverage` | 핵심 코드 줄 97.83%, 분기 88.30% |
| `npx playwright test` | Electron 2개 통과. 키 암호화·재시작·삭제 및 가상 마이크→모의 OpenAI 전사/정리→복사 대기/결과 닫기 |
| `node --test native/test.mjs` | macOS 2개 통과. 대상 없는 입력 거부와 테스트 전용 클립보드의 형식·소유권 보존 |
| Apple Silicon 앱 번들 | 임시 프로필로 실행하고 포함된 arm64 보조 프로그램이 시작되는 것을 확인 |
| Intel 앱 번들 | Intel용 앱과 보조 프로그램의 x86_64 아키텍처 확인, Intel 기기 미실행 |
| 설치 이미지 | 두 DMG의 `hdiutil verify` 및 두 앱의 `codesign --verify --deep --strict` 통과. 로컬 서명, Apple 공증 없음 |

보안 경계 테스트는 처음에 미구현 모듈에서 실패하는 것을 확인한 뒤 추가했습니다. 보조 프로그램의 복원 경고 테스트도 경고가 전달되지 않아 실패하는 것을 보고 수정했습니다. 테스트용 마이크와 OpenAI 응답 및 복사 동작은 사용자의 실제 데이터나 클립보드와 분리했습니다.

설치 파일의 SHA-256:

```text
6cd488fc51e7edaf69b830dda70dd2bbdf7654e9dcb1a0dc9514691934d814eb  VoiceInput-0.1.0-mac-arm64.dmg
7b06f24add0cbdf45064a53d191e9280b08303d49a272b1420d0ef6891f4b23e  VoiceInput-0.1.0-mac-x64.dmg
```

실제 API 키와 과금 호출, 실제 마이크와 접근성 권한, 전역 단축키 입력 및 외부 편집기에 실제로 붙여넣는 동작은 검증하지 않았습니다. Windows x64는 소스와 NSIS 빌드 설정을 제공하며 Windows용 실행 파일은 생성하지 않았습니다.
