# LNLogin — manual build controller

Repo public chỉ chứa controller. Source ở private
[nguyenducluongg/lnlogin](https://github.com/nguyenducluongg/lnlogin), không được
publish ra repo/log/artifacts/cache public. Dùng nội bộ, không thương mại;
giấy phép thành phần bên thứ ba giữ nguyên.

## Thiết lập sau đổi tên

Repo này → Settings → Environments → **private-source-build** → thêm secret
**LNLOGIN_SOURCE_TOKEN**: PAT riêng cho repo `lnlogin`, Contents read/write,
Metadata read. Không dùng credential Git của máy dev/broad token, không đưa
token vào workflow input/source/chat. Workflow mới không đọc secret tên cũ.

## Bấm build

1. Source và controller phải push trước; Actions không đọc sửa local.
2. [Actions → Build LNLogin manually](https://github.com/nguyenducluongg/lnbrowserbuild/actions/workflows/manual-build.yml)
   → **Run workflow mới**, branch `main`.
3. `source_ref=main` hoặc full source SHA; mỗi lượt chọn một platform:
   `macos-arm64`, `windows-x64`, `linux-x64`.
4. Giữ **run_tests=true**, **bundle_engine=false**, **app_revision=3** (tăng nếu
   revision đó đã được công bố). Approve environment nếu có reviewer.
5. Kết quả ở [Releases private](https://github.com/nguyenducluongg/lnlogin/releases).
   Thành công có native installer, manifest/provenance, `LNLOGIN-UPDATE.json`;
   thất bại giữ private draft diagnostics/build.log. Không tự dispatch Actions.

`bundle_engine=false` chỉ build manager. Người dùng tải engine riêng trong app
qua https://lnlogin.com; PAT nằm gateway, không trên máy chạy app. Engine update
không cần build lại manager nếu API/schema tương thích. App update tải installer
và cài thủ công. Admin Sync → Sẵn sàng → Xem lại → Công bố.

All-in-one `bundle_engine=true` là tùy chọn legacy: cần pin r2 mới trong source
`binary/release-assets.json`. Không dùng pins r1 với catalog r2. Không có pin đúng
phải fail closed trước download. Gói ghép dùng launcher `Start-LNLogin.cmd`,
state/cache/temp `.runtime` cạnh gói; không di chuyển/xóa dữ liệu cũ hoặc hạ
sandbox/security. Linux cần DISPLAY/Xvfb sẵn có, không tự cài web/VNC.

## Kiểm tra và giới hạn

- Chỉ owner/manual/main-branch được chạy; push/PR/tag/schedule không auto build.
- Source/private release access kiểm tra trước checkout; tokens chỉ tới GitHub
  API private, không gửi sang CDN/downloader/compiler. Installer selection chỉ
  native assets; source/debug/map không public. Một build một OS, Cargo jobs=1.
- Frontend typecheck/regression và package/provenance checks trước publication.
  Không repatch/re-sign engine trên runner hoặc launch browser E2E.
- Sau đổi controller, không Re-run job cũ: tạo Run workflow mới.
- Test nhẹ ngày 2026-10-07: 40 controller fixtures PASS trên Mac, gồm synthetic
  ZIP/package tests; không chứng nhận native Windows/Linux hoặc compilation mới.
  Source rename regression có thêm namespace và DataPack fixtures.

Kiểm tra local: đặt TMPDIR ở storage được phép rồi
`node --max-old-space-size=128 --test --test-concurrency=1 ci/*.test.mjs`.
CI vẫn cần user chạy để xác nhận compilation/installer mới.
