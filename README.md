# Bộ build thủ công cho Donut nội bộ

Repo public này chỉ chứa controller build cho **bản fix nội bộ, không thương mại**.
Source app nằm ở [donut private](https://github.com/nguyenducluongg/donut).
Không có source app, browser bundle hoặc profiles trong repo public.

## Bấm build

1. Mở [Actions → Build Donut manually](https://github.com/nguyenducluongg/lnbrowserbuild/actions/workflows/manual-build.yml).
2. Bấm **Run workflow mới**, branch `main`.
3. `source_ref=main` hoặc full commit SHA source; chọn `macos-arm64` cho Mac
   Apple Silicon, giữ `run_tests=true`.
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

Lỗi Node test đọc workflow không còn dùng đã sửa. Controller tests: 9 PASS.
Fresh compilation/package/runtime vẫn chờ lượt người dùng tự bấm build.
Public failure chỉ nêu stage; đọc `build.log` ở private draft để biết lỗi chính xác.

## Thư mục trên SSD và quyền sử dụng

`/Volumes/SSD/Desktop/vibecoding/donutbrowser/workspace`:
`donut/` là source; `lnbrowserbuild/` là controller; binary và tài liệu bản fix
ở cùng workspace. Hướng dẫn source chi tiết nằm trong private `docs/BUILD.md`.

Controller dùng theo [LICENSE nội bộ](LICENSE). Repo public phục vụ build,
không phải release source app hoặc lời cấp phép sử dụng thương mại.
Third-party tools/GitHub Actions giữ giấy phép riêng.

Kiểm tra nhẹ: `node --test ci/private-release.test.mjs`; lệnh này không build app.
