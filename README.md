# Bộ build thủ công cho Donut nội bộ

Repo public này chỉ chứa controller build cho **bản fix nội bộ, không thương mại**.
Source app nằm ở [donut private](https://github.com/nguyenducluongg/donut).
Không có source app, browser bundle hoặc profiles trong repo public.

## Bấm build

1. Mở [Actions → Build Donut manually](https://github.com/nguyenducluongg/lnbrowserbuild/actions/workflows/manual-build.yml).
2. Bấm **Run workflow mới**, branch `main`.
3. `source_ref=main` hoặc full commit SHA source; chọn `macos-arm64`,
   `windows-x64` hoặc `linux-x64`, giữ `run_tests=true`.
   Mặc định `bundle_engine=false`: chỉ build installer app, không cần engine pin.
   `app_revision=1` ở bản đầu; tăng revision khi rebuild cùng version app.
   Build tự đính kèm `DONUT-UPDATE.json` vào private Release. Trên gateway chỉ
   Đồng bộ → tick bản Sẵn sàng → Công bố, không nhập hash/catalog/OS thủ công.
4. Bấm nút xanh; approve environment nếu đã cấu hình.
5. Tải kết quả/log ở [Releases private](https://github.com/nguyenducluongg/donut/releases).
   Success tạo prerelease private; failure giữ draft với `build.log` và manifest.

Mặc định tải installer native Donut (.dmg/.exe/.deb/.AppImage). Binary Wayfern
tải riêng trong app từ `https://browser.diemdien.com`, không cấu hình GitHub PAT
trên máy chạy app. Source và outputs vẫn lưu Releases private; gateway chỉ công
bố các installer/engine mà admin đã chọn. Không tự trigger Actions.

Nếu chủ động chọn `bundle_engine=true`, cần engine pins còn đúng trong source.
Khi đó tải **một gói** `Donut-macos-arm64.tar.gz`, `Donut-windows-x64.zip` hoặc
`Donut-linux-x64.tar.gz`. Gói chứa manager, fixed engine native, catalog,
manifest và launcher. Giải nén toàn bộ trên ổ muốn lưu dữ liệu, đọc
`START-HERE.txt`, thoát Donut đang chạy rồi dùng launcher.
Mac có `.app` chạy tại chỗ; Windows cài installer trong `manager/` rồi dùng
`Start-Donut.cmd` (có thể truyền đường dẫn app đã cài); Linux có AppImage/deb,
launcher cần DISPLAY có sẵn, kể cả Xvfb. Không tự cài VNC hay bật API/settings.
Launcher giữ state/cache/temp của manager trong `.runtime` cạnh gói; không
chuyển dữ liệu cũ và không thay đổi chính sách bảo mật OS.

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
  source, file .env hay chat. Secret không được chuyển tới install/build hoặc
  Python đóng gói; chỉ downloader API private và publisher được nhận token.

[GitHub token docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
và [environment docs](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Phạm vi và bảo mật

- Build manager và tải engine ZIP **đã fix** từ Releases của source private,
  ghim asset ID/kích thước/SHA-256 theo đúng source commit, không dùng latest.
  Kiểm tra toàn ZIP rồi catalog payload hashes trước khi đóng chung. Không
  repatch/re-sign engine; Mac xác minh codesign read-only. Không launch browser
  hoặc thay thế runtime acceptance. Catalog tự lấy từ source, không upload riêng.
- Chỉ success nếu compile **và** bundling thành công; gói vượt 2 GiB/asset,
  checksum sai, thiếu slot hoặc không đủ disk phải fail, không manager-only PASS.
  macos-x64 chưa có fixed engine nên tạm không có trong menu build.
- `run_tests=true` chạy Rust filters `local_agent`, `local_wayfern` và
  `local_runtime` tuần tự. Bản source local-only chặn browser/manager updates
  nguồn gốc; package kèm payload native tương ứng. Các kiến trúc khác vẫn pending.
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
Controller tests lịch sử sau path fix: **23 PASS trên Mac**, gồm Windows/POSIX paths,
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

Kiểm tra nhẹ: `node --max-old-space-size=256 --test --test-concurrency=1
ci/private-release.test.mjs ci/run-build.test.mjs ci/bundle-engine.test.mjs`.
Ngày 2026-10-06 sau sửa Windows fixture: **35 Node PASS trên Mac**, gồm wrapper
chạy **11 Python PASS** với ZIP
giả lập nhỏ. Không tải engine thật/build app/launch browser; native package và
runtime vẫn chờ lượt build thủ công của người dùng. Đặt TMPDIR ở storage được
phép trên máy test (SSD ngoài ở lab Mac).

Windows run lúc 18:59 UTC ngày 2026-10-05 với controller `4b9c99e` dừng ở
bootstrap tests: 34/35 Node PASS, Python có 2 FAIL/1 ERROR do kỳ vọng Unix
symlinks và normalization của ZIP fixture. Chưa checkout source private,
compile manager hoặc tải engine. Đã tách regular-file/hash coverage khỏi
symlink policy native, giữ kiểm tra từ chối symlink trên Windows và kiểm tra
tên ZIP gốc trước normalization. Không tắt checksum/tests; Linux archive case
vẫn chỉ chạy Unix như trước. Native Windows retest chờ Run workflow mới.
