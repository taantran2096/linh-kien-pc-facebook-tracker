# Linh Kiện PC Facebook Tracker v0.5.1

Extension Chrome tự động theo dõi giá **CPU, VGA (Cạc đồ hoạ), Mainboard (Bo mạch chủ), RAM, SSD / NVMe** trên các hội nhóm mua bán Facebook. Tích hợp bộ lọc chống spam bài lặp, lọc giá ảo gõ nhầm, nhận diện bài đã bán và cảnh báo kèo thơm trực tiếp lên Desktop.

---

### Thay đổi v0.5.1 (sửa lỗi nội dung không khớp thông báo)
- `content-post.js`: sửa lỗi lọc ngược (lấy bình luận thay vì nội dung bài); chọn đúng bài theo ID trong URL; chỉ đọc trong khung bài, chờ nội dung ổn định sau "Xem thêm"; lấy tác giả đúng.
- `content-notifications.js`: xác định đúng khối của từng thông báo nên đoạn trích, tên nhóm, lọc từ khoá và lọc cross-post không còn bị lẫn.
- `background.js`: chỉ phân tích nội dung bài (bình luận của chính người đăng chỉ dùng để nhận biết "đã bán"); kiểm tra key bài khớp hàng đợi; ghi chú trong nhật ký nếu nội dung không khớp thông báo.

## 🌟 Các tính năng nổi bật (Phiên bản v0.5.0)

### 0. Theo dõi toàn diện 5 nhóm linh kiện PC chính
- **CPU**: Đầy đủ Intel Core i3..i9 Gen 2-14, Core Ultra 5/7/9, Xeon E3/E5/Scalable, AMD Ryzen 3/5/7/9 (Zen 1 đến Zen 5, X3D).
- **VGA (Card màn hình)**: NVIDIA RTX 40/30/20 series, GTX 16/10 series, AMD Radeon RX 7000/6000/500 series, Intel Arc.
- **Mainboard (Bo mạch chủ)**: Bo mạch Intel (H61..H610, B75..B760, Z87..Z890) và AMD (A320/A520/A620, B350..B650, X370..X870E) kèm các dòng phổ biến (Mortar, Tomahawk, TUF, ROG, Aorus...).
- **RAM (Bộ nhớ trong)**: Chuẩn DDR3, DDR4, DDR5, các mức dung lượng (8GB, 16GB, 32GB, 64GB, Kit 2x8GB, Kit 2x16GB) và bus RAM.
- **SSD / NVMe (Ổ cứng)**: NVMe M.2 PCIe Gen 3/4/5 và SATA SSD, nhận diện dung lượng (128GB, 256GB, 512GB, 1TB, 2TB) và các dòng phổ biến (Samsung 980/990, Kingston NV2/NV3, WD Black SN770/SN850X...).
- **Bộ lọc danh mục**: Chọn nhanh `Tất cả linh kiện`, `CPU`, `VGA`, `Mainboard`, `RAM`, `SSD / NVMe` ngay trên Dashboard.
- **Wishlist đa linh kiện**: Đặt giá trần mong muốn cho bất kỳ linh kiện nào (ví dụ: `RTX 3060 ≤ 5tr`, `Samsung 980 Pro ≤ 2tr`). Kích hoạt thông báo Chrome tức thì khi có người đăng bán rẻ hơn!

### 1. Tự động tạm dừng khi gặp lỗi liên tiếp & Kiểm tra bảo mật (Checkpoint)
- Khi gặp **5 bài lỗi liên tiếp** (hoặc thời gian chờ quá lâu), extension tự động tạm dừng mở tab để bảo vệ an toàn cho tài khoản Facebook.
- Nhận diện ngay lập tức trang đăng nhập, màn hình kiểm tra bảo mật (Checkpoint/xác minh danh tính): extension dừng tức thì, biểu tượng chuyển sang màu đỏ với huy hiệu **`ERR`** và phát thông báo Chrome cho người dùng.

### 2. Loại bài đăng lặp (Deduplication trong 48 giờ)
- Tự động gom bài theo **Người đăng + Mẫu CPU + Mức giá** trong vòng 48 giờ.
- Các bài "up bài" hoặc đăng chéo nhiều nhóm sẽ được đánh dấu thẻ **`LẶP`** và tự động loại khỏi thống kê trung vị / trung bình để không làm sai lệch số lượng bài thực tế.

### 3. Nhận diện "Đã bán" / "Đã bay" / "Có gạch"
- Tự động quét các từ khoá: `đã bán`, `sold`, `hết hàng`, `đã bay`, `có gạch`, `đang cọc`, `done` ở cả bài viết và các bình luận chốt đơn.
- Gắn thẻ **`ĐÃ BÁN`**. Mặc định tách riêng khỏi giá đang rao bán nhưng vẫn giữ lại để người mua tham khảo "giá chốt thực tế".
- Bộ lọc có tuỳ chọn: *Chỉ bài đang rao*, *Chỉ bài đã bán (Giá chốt)*, hoặc *Tất cả*.

### 4. Danh sách theo dõi kèm giá mong muốn (Wishlist & Cảnh báo kèo)
- Thêm mẫu CPU muốn mua và mức giá tối đa (ví dụ: `Ryzen 5 7500F ≤ 2tr8`, `i5-12400F ≤ 2tr3`).
- Khi phát hiện bài mới có giá bằng hoặc rẻ hơn, Chrome sẽ lập tức bật **thông báo desktop kèm link bài viết**. Bấm vào thông báo sẽ mở ngay bài viết để bạn chốt đơn nhanh tay hơn người khác.
- Lưu lại lịch sử các bài khớp kèo trong tab riêng.

### 5. Lọc giá bất thường & Gõ nhầm (Outlier Anomaly Detection)
- Tự động phát hiện các bài gõ nhầm (ví dụ: gõ `22tr` thay vì `2tr2`, hoặc `200k` thay vì `2tr`).
- Tự động đưa vào mục **"Cần kiểm tra & Giá ảo"**, không tính vào biểu đồ và trung vị cho đến khi người dùng xác nhận hoặc sửa lại giá đúng.
- Có công tắc bật/tắt nhanh **"Lọc giá bất thường"** ngay tại bộ lọc.

### 6. Xu hướng giá (So sánh với tuần trước)
- Thêm cột **"Xu hướng tuần"** trong bảng giá cho từng mẫu CPU.
- Tính toán độ lệch giữa trung vị 7 ngày gần nhất và 7 ngày trước đó:
  - `↓ -150k (-6.2%)` màu xanh lá (giá đang giảm - thời điểm tốt để mua).
  - `↑ +100k (+4.5%)` màu đỏ (giá đang tăng).
  - `→ Không đổi` hoặc `Mới`.

### 7. Sao lưu & Dọn dẹp dữ liệu (JSON Backup & Auto-Prune)
- **Xuất / Nhập JSON**: Tải file sao lưu toàn bộ dữ liệu chỉ với 1 click để không lo mất lịch sử khi cài lại máy hoặc đổi trình duyệt.
- **Tự động dọn dẹp**: Tự động lược bỏ nội dung văn bản gốc của các bài cũ hơn 90 ngày nhằm tiết kiệm bộ nhớ Chrome (`chrome.storage.local`), nhưng **vẫn giữ nguyên lịch sử giá, ngày tháng và mẫu CPU** để bảng thống kê và biểu đồ không bị ảnh hưởng.

### 8. Mở rộng nhận diện CPU & Sẵn sàng cho linh kiện khác
- Bổ sung **AMD Ryzen 3**: 1200, 1300X, 2200G, 3100, 3200G, 3300X, 4100, 4300G, 5300G.
- Bổ sung **Intel Xeon**: Dòng E3 (E3-1230v2, v3...), Dòng E5 (E5-2670, 2680v2, 2678v3, 2680v4, 2696v3...), Xeon Silver & Gold.
- Bổ sung **Intel Core Ultra**: Ultra 5 245K/KF, Ultra 7 265K/KF, Ultra 9 285K.
- Bổ sung **Pentium Gold & Celeron**: G4560, G5400, G6400, G6900, G7400.
- Bổ sung **AMD Athlon** (200GE, 3000G) & **Threadripper**.
- Khung cấu trúc tách lớp `category: 'CPU'` sẵn sàng mở rộng sang VGA, RAM, Mainboard.

---

## 🚀 Hướng dẫn cài đặt lên Chrome

1. Tải bộ file extension về máy.
2. Mở trình duyệt Chrome và truy cập vào: `chrome://extensions/`
3. Bật công tắc **"Chế độ dành cho nhà phát triển" (Developer mode)** ở góc trên bên phải.
4. Bấm nút **"Tải tiện ích đã giải nén" (Load unpacked)**.
5. Chọn thư mục chứa các file extension (`manifest.json`, `background.js`, `analyzer.js`, ...).
6. Đăng nhập Facebook trên Chrome. Extension sẽ tự động mở và ghim tab thông báo `facebook.com/notifications`.
7. Bấm vào biểu tượng của extension trên thanh công cụ Chrome để mở Bảng điều khiển giá!

---

## 📁 Danh sách tệp trong Extension
- `manifest.json`: Cấu hình quyền `storage`, `tabs`, `alarms`, `notifications`.
- `analyzer.js`: Lõi phân tích văn bản, nhận diện CPU, tách giá, kiểm tra "đã bán", lọc giá ảo và tính xu hướng.
- `background.js`: Hàng đợi đọc bài bằng tab Facebook ghim, tự quay lại thông báo sau mỗi bài, cơ chế tự dừng khi gặp 5 lỗi hoặc checkpoint, deduplication 48h, cảnh báo kèo thơm.
- `content-notifications.js`: Quét thông báo chưa đọc từ Facebook.
- `content-post.js`: Tự động bấm "Xem thêm", đọc nội dung và phát hiện checkpoint bảo mật.
- `content-visible.js`: Giả lập hiển thị để Facebook tải đầy đủ bài viết ở tab nền.
- `dashboard.html` / `dashboard.css` / `dashboard.js`: Giao diện bảng điều khiển 5 tab đa chức năng.
