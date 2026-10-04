# Bộ build thủ công cho Donut nội bộ

Repo public này chỉ chứa controller build cho **bản fix nội bộ, không thương mại**.
Source app nằm ở [donut private](https://github.com/nguyenducluongg/donut).
Không có source app, browser bundle hoặc profiles trong repo public.

## Bấm build

1. Mở [Actions → Build Donut manually](https://github.com/nguyenducluongg/lnbrowserbuild/actions/workflows/manual-build.yml).
2. Bấm **Run workflow mới**, branch `main`.
3. `source_ref=main` hoặc full commit SHA source; chọn `macos-arm64` cho Mac
   Apple Silicon hoặc `windows-x64` cho Windows, giữ `run_tests=true`.
4. Bấm nút xanh; approve environment nếu đã cấu hình.
5. Tải kết quả/log ở [Releases private](https://github.com/nguyenducluongg/donut/releases).
   Success tạo prerelease private; failure giữ draft với `build.log` và manifest.

Push/PR/tag/schedule không chạy build. Chỉ owner chạy từ `main`, một platform
mỗi lượt. Sau cập nhật controller phải tạo run mới, không rerun job cũ.
[GitHub rerun semantics](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

## Token và environment

Lượt đầu đã xác minh token/checkout/private log upload hoạt động.
Chỉ cần setup lại khi mất cấu hình, token hết hạn hoặc đổi quyền:

- Environment `private-source-build`, chỉ branch `main`.
- Environment secret `DONUT_SOURCE_TOKEN`: fine-grained token chỉ chọn repo
  `donut`, Contents read/write, Metadata read. Write dùng lưu private Releases.
- Không dùng All repositories/broad token hoặc nhập token vào workflow input,
  source, file .env hay chat. Secret không được chuyển tới install/build steps.

[GitHub token docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
và [environment docs](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Phạm vi và bảo mật

- Chỉ build manager Donut, không download/embed/repatch/sign Wayfern.
  Không launch browser hoặc thay thế fresh REST/MCP acceptance.
- `run_tests=true` chạy Rust filters `local_agent`, `local_wayfern` và
  `local_runtime` tuần tự. Bản source local-only chặn browser/manager updates
  nguồn gốc; runtime cần catalog/payload fixed local riêng. Windows/Linux
  payloads vẫn pending.
- Controller luôn kiểm tra bootstrap/private publisher trước checkout source:
  Windows dùng Git Bash native theo đường dẫn cụ thể, không chọn WSL qua PATH.
  Shell scripts được ghim LF qua `.gitattributes` khi checkout Windows.
  Compiler output streaming vào log private, có startup error/exit/signal.
  Log rỗng/mất được ghi placeholder rõ ràng, không coi build là thành công.
- macOS ad-hoc signed, không notarized; Windows unsigned.
- Standard hosted runner; Node 24, pinned pnpm, frozen lockfiles, Cargo jobs=1.
  Không build trên Mac local, không self-hosted runner.
- Compiler/test/install/package output và artifacts lưu private. Không public
  upload-artifact/source archives/dependency cache.
- Kiểm tra repo source còn private trước checkout/upload; Git credentials
  không persist. Public vẫn có thể thấy status/timing/platform/inputs/commit hashes.
  Không đưa branch names mật vào input. Runner/dependencies vẫn phải được tin cậy.
- [Standard public hosted compute](https://docs.github.com/en/billing/concepts/product-billing/github-actions);
  không larger runners, không cam kết mọi storage/product charge bằng 0.

Lỗi Node test đọc workflow không còn dùng đã sửa; frontend/typecheck chạy trước
release sidecar compile. Rust còn filter `local_runtime` cho lazy RAM recovery.
Controller tests sau path fix: **23 PASS trên Mac**, gồm Windows/POSIX paths,
startup/streaming và log rỗng/mất. Lượt Windows dùng `293dec8` có 21/22 PASS,
chỉ fail helper giả lập POSIX path dùng host-native resolver; đã đổi sang
explicit `path.posix`/`path.win32`, giữ assertion và bổ sung regression.
Actual tiny Git Bash smoke đã PASS trên native Windows. Lượt đó dừng trước
token/source checkout nên chưa build app và chưa tạo private diagnostic draft;
controller test error đọc trực tiếp trong public log. Native suite mới và
fresh compilation/package/runtime vẫn chờ người dùng bấm Run workflow mới.
Public compiler/publisher failure chỉ nêu stage hoặc phase/HTTP status; không HTTP bodies/compiler
output. Draft link in ngay sau tạo release, kể cả upload sau đó fail; đọc
`build.log` private. Windows run `37204383317` chỉ lưu được manifest, không log;
không suy command bị lỗi hoặc yêu cầu đổi token từ dòng publish chung.

## Thư mục trên SSD và quyền sử dụng

`/Volumes/SSD/Desktop/vibecoding/donutbrowser/workspace`:
`donut/` là source; `lnbrowserbuild/` là controller; binary và tài liệu bản fix
ở cùng workspace. Hướng dẫn source chi tiết nằm trong private `docs/BUILD.md`.

Controller dùng theo [LICENSE nội bộ](LICENSE). Repo public phục vụ build,
không phải release source app hoặc lời cấp phép sử dụng thương mại.
Third-party tools/GitHub Actions giữ giấy phép riêng.

Kiểm tra nhẹ: `node --test --test-concurrency=1 ci/private-release.test.mjs ci/run-build.test.mjs`;
lệnh này chỉ dùng mocks/tiny shell fixture, không build app.
