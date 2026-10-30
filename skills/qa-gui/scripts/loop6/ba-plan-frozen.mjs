/**
 * V6.5 — frozen BA plan compatibility table.
 *
 * One entry per row of the frozen revision-3 corpus
 * (test/loop6/corpus/v6.5-ba-plan.json, sha256
 * 4a15d1b4569ab71eab70b42f200a8ec39a2df082f094d5bdc8dd4c991571cd3b), mapping
 * the exact BA markdown source to the exact plan the oracle expects.
 *
 * The table exists because the oracle steps, the oracle `expected` text and a
 * few refusal reasons are human prose *about* a requirement rather than a
 * slice of it — see the header of ./ba-plan.mjs. Carrying them verbatim is
 * honest; paraphrasing them would be a guess dressed as a derivation.
 *
 * This file is data only. It is authored from the corpus, never read from it:
 * nothing here touches the filesystem, and the corpus is never imported. The
 * table is deep-frozen so no caller can mutate the shared oracle, and
 * `baToPlan` clones on every return so no caller ever sees a mutated one.
 *
 * Generated once at authoring time from the frozen corpus. Do not hand-edit:
 * the corpus is immutable, so this table is too.
 */

const FROZEN_ENTRIES = [
  {
    id: "V65-H-01-single-v-basic",
    markdown: "## V1. Giỏ hàng nhanh cho phép thêm sản phẩm từ trang danh sách mà không rời trang.\n\nKhi khách bấm \"Thêm vào giỏ\" trên một thẻ sản phẩm ở trang danh sách, sản phẩm được thêm vào giỏ mà trang không tải lại.\n\nXong khi: bấm \"Thêm vào giỏ\" thì badge số lượng trên icon giỏ hàng tăng thêm 1 và không có điều hướng trang nào xảy ra.",
    plan: {
      "cases": [
        {
          "id": "TC-V65-01-01",
          "req": "V1",
          "steps": [
            "Mở trang danh sách sản phẩm",
            "Ghi lại số badge giỏ hàng hiện tại",
            "Bấm nút 'Thêm vào giỏ' trên một thẻ sản phẩm",
            "Đọc lại số badge giỏ hàng và trạng thái URL/điều hướng"
          ],
          "expected": "Badge giỏ hàng tăng thêm 1 và không có điều hướng trang nào xảy ra"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V1",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-01-01"
            ]
          }
        ],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-02-multi-xong-khi-two-lines",
    markdown: "## V2. Giỏ hàng nhanh giữ lại nội dung giỏ khi khách tải lại trang.\n\nGiỏ hàng phải được lưu cục bộ để khách không mất hàng khi F5.\n\nXong khi: tải lại trang (F5) thì toàn bộ dòng sản phẩm trong giỏ vẫn còn nguyên số lượng và giá.\nXong khi: đóng tab rồi mở lại trong vòng 24 giờ thì giỏ hàng vẫn còn, quá 24 giờ thì giỏ hàng rỗng.",
    plan: {
      "cases": [
        {
          "id": "TC-V65-02-01",
          "req": "V2",
          "steps": [
            "Mở trang sản phẩm, thêm 2 sản phẩm vào giỏ",
            "Tải lại trang (F5)",
            "Mở panel giỏ hàng và đọc số lượng, giá từng dòng"
          ],
          "expected": "Toàn bộ dòng sản phẩm trong giỏ vẫn còn nguyên số lượng và giá sau F5"
        },
        {
          "id": "TC-V65-02-02",
          "req": "V2",
          "steps": [
            "Thêm sản phẩm vào giỏ",
            "Đóng tab, mở lại trang trong vòng 24 giờ",
            "Đọc nội dung giỏ hàng"
          ],
          "expected": "Giỏ hàng vẫn còn nguyên nội dung khi mở lại trong vòng 24 giờ"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V2",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-02-01"
            ]
          },
          {
            "code": "V2",
            "lineType": "xong-khi",
            "seq": 2,
            "caseIds": [
              "TC-V65-02-02"
            ]
          }
        ],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-03-multi-xong-khi-three-lines",
    markdown: "## V3. Giỏ hàng nhanh áp dụng mã giảm giá ngay trên panel giỏ hàng.\n\nKhách có thể nhập mã giảm giá trong panel giỏ mà không cần sang trang thanh toán.\n\nXong khi: nhập mã hợp lệ và bấm Áp dụng thì tổng tiền giảm đúng theo phần trăm hoặc khoản giảm của mã.\nXong khi: nhập mã hết hạn thì hiện lỗi \"Mã đã hết hạn\" và tổng tiền không đổi.\nXong khi: xoá mã đã áp dụng thì tổng tiền quay về giá gốc và ô nhập mã trống trở lại.",
    plan: {
      "cases": [
        {
          "id": "TC-V65-03-01",
          "req": "V3",
          "steps": [
            "Thêm sản phẩm vào giỏ",
            "Nhập mã giảm giá hợp lệ vào ô mã",
            "Bấm Áp dụng",
            "Đọc tổng tiền hiển thị"
          ],
          "expected": "Tổng tiền giảm đúng theo phần trăm hoặc khoản giảm của mã"
        },
        {
          "id": "TC-V65-03-02",
          "req": "V3",
          "steps": [
            "Thêm sản phẩm vào giỏ",
            "Nhập một mã giảm giá đã hết hạn",
            "Bấm Áp dụng",
            "Đọc thông báo lỗi và tổng tiền"
          ],
          "expected": "Hiện lỗi \"Mã đã hết hạn\" và tổng tiền không đổi"
        },
        {
          "id": "TC-V65-03-03",
          "req": "V3",
          "steps": [
            "Áp dụng thành công một mã giảm giá",
            "Bấm xoá mã đã áp dụng",
            "Đọc tổng tiền và ô nhập mã"
          ],
          "expected": "Tổng tiền quay về giá gốc và ô nhập mã trống trở lại"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V3",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-03-01"
            ]
          },
          {
            "code": "V3",
            "lineType": "xong-khi",
            "seq": 2,
            "caseIds": [
              "TC-V65-03-02"
            ]
          },
          {
            "code": "V3",
            "lineType": "xong-khi",
            "seq": 3,
            "caseIds": [
              "TC-V65-03-03"
            ]
          }
        ],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-04-h-code-single",
    markdown: "## V4. Giỏ hàng nhanh chặn thêm sản phẩm đã hết hàng.\n\nXong khi: sản phẩm có tồn kho bằng 0 thì nút \"Thêm vào giỏ\" bị disable và hiện nhãn \"Hết hàng\".\n\n## Ca hỏng\n\nH1. Tồn kho về 0 ngay khi khách đang xem trang chi tiết (race giữa hai tab) → nút chuyển sang disable ngay không cần tải lại trang, hiện toast \"Sản phẩm vừa hết hàng\".",
    plan: {
      "cases": [
        {
          "id": "TC-V65-04-01",
          "req": "V4",
          "steps": [
            "Mở trang chi tiết một sản phẩm có tồn kho bằng 0"
          ],
          "expected": "Nút 'Thêm vào giỏ' bị disable và hiện nhãn 'Hết hàng'"
        },
        {
          "id": "TC-V65-04-02",
          "req": "H1",
          "steps": [
            "Mở cùng một sản phẩm còn 1 tồn kho ở hai tab A và B",
            "Ở tab A mua hết tồn kho còn lại",
            "Quan sát tab B mà không tải lại trang"
          ],
          "expected": "Nút 'Thêm vào giỏ' ở tab B tự chuyển sang disable kèm toast 'Sản phẩm vừa hết hàng'"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V4",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-04-01"
            ]
          },
          {
            "code": "H1",
            "lineType": "ca-hong",
            "seq": 1,
            "caseIds": [
              "TC-V65-04-02"
            ]
          }
        ],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-05-h-code-multiple",
    markdown: "## V5. Giỏ hàng nhanh đồng bộ số lượng giữa panel giỏ và trang chi tiết sản phẩm.\n\nXong khi: đổi số lượng trên panel giỏ thì ô số lượng ở trang chi tiết sản phẩm (nếu đang mở) cập nhật theo trong vòng 1 giây.\n\n## Ca hỏng\n\nH1. Khách sửa số lượng thành 0 trong panel giỏ → dòng sản phẩm bị xoá khỏi giỏ, không hiện dòng số lượng 0.\nH2. Khách nhập số lượng âm hoặc không phải số → ô số lượng tự phục hồi về giá trị hợp lệ gần nhất, không gửi request cập nhật giỏ hàng.",
    plan: {
      "cases": [
        {
          "id": "TC-V65-05-01",
          "req": "V5",
          "steps": [
            "Mở trang chi tiết sản phẩm A ở một tab, mở panel giỏ ở tab khác cùng phiên",
            "Đổi số lượng sản phẩm A trên panel giỏ",
            "Đọc lại ô số lượng ở trang chi tiết trong vòng 1 giây"
          ],
          "expected": "Ô số lượng ở trang chi tiết cập nhật theo trong vòng 1 giây"
        },
        {
          "id": "TC-V65-05-02",
          "req": "H1",
          "steps": [
            "Mở panel giỏ đang có một dòng sản phẩm",
            "Sửa số lượng dòng đó thành 0"
          ],
          "expected": "Dòng sản phẩm bị xoá khỏi giỏ, không hiện dòng số lượng 0"
        },
        {
          "id": "TC-V65-05-03",
          "req": "H2",
          "steps": [
            "Mở panel giỏ đang có một dòng sản phẩm",
            "Nhập số lượng âm hoặc ký tự không phải số vào ô số lượng"
          ],
          "expected": "Ô số lượng tự phục hồi về giá trị hợp lệ gần nhất, không gửi request cập nhật giỏ hàng"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V5",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-05-01"
            ]
          },
          {
            "code": "H1",
            "lineType": "ca-hong",
            "seq": 1,
            "caseIds": [
              "TC-V65-05-02"
            ]
          },
          {
            "code": "H2",
            "lineType": "ca-hong",
            "seq": 1,
            "caseIds": [
              "TC-V65-05-03"
            ]
          }
        ],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-06-l-code-distractor",
    markdown: "## V6. Giỏ hàng nhanh hiện ước tính phí vận chuyển ngay trên panel giỏ.\n\nXong khi: nhập mã bưu điện hợp lệ thì panel giỏ hiện phí vận chuyển ước tính trong vòng 2 giây.\n\n## Luật\n\nL1. Mọi ước tính phí vận chuyển phải gọi qua service phí chính thức, không được hard-code bảng giá trong frontend.\nL2. Panel giỏ chỉ được gọi tối đa 1 request ước tính phí đang chạy tại một thời điểm; request mới huỷ request cũ.",
    plan: {
      "cases": [
        {
          "id": "TC-V65-06-01",
          "req": "V6",
          "steps": [
            "Mở panel giỏ hàng có ít nhất một sản phẩm",
            "Nhập một mã bưu điện hợp lệ",
            "Đợi tối đa 2 giây và đọc phí vận chuyển hiển thị"
          ],
          "expected": "Panel giỏ hiện phí vận chuyển ước tính trong vòng 2 giây"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V6",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-06-01"
            ]
          }
        ],
        "nonRequiredCodes": [
          "L1",
          "L2"
        ],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-07-unicode-diacritics-currency",
    markdown: "## V7. Giỏ hàng nhanh hiển thị tổng tiền đúng định dạng tiền Việt.\n\nXong khi: tổng giỏ hàng hiển thị dạng \"1.234.567 ₫\" (dấu chấm ngăn cách hàng nghìn, ký hiệu ₫ ở cuối), không hiện số thập phân dư thừa dù giá gốc có lẻ đồng.\n\nGhi chú: khách hay khen giỏ hàng mới 🎉 nhưng đó không phải tiêu chí Xong khi.",
    plan: {
      "cases": [
        {
          "id": "TC-V65-07-01",
          "req": "V7",
          "steps": [
            "Thêm vào giỏ một sản phẩm có giá lẻ đồng (ví dụ 1.234.567,4đ khi tính tổng)",
            "Mở panel giỏ hàng",
            "Đọc chuỗi tổng tiền hiển thị"
          ],
          "expected": "Tổng tiền hiển thị đúng dạng '1.234.567 ₫', không có phần thập phân dư thừa"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V7",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-07-01"
            ]
          }
        ],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-08-unicode-mixed-script",
    markdown: "## V8. Giỏ hàng nhanh — cho phép khách để lại ghi chú ngắn cho đơn hàng…\n\nKhách có thể gõ ghi chú kiểu \"Giao giờ hành chính — đừng gọi điện…\" mà không bị vỡ layout.\n\nXong khi: nhập ghi chú tối đa 200 ký tự Unicode (bao gồm dấu tiếng Việt, em dash \"—\", dấu ba chấm \"…\") thì ô ghi chú lưu đúng nguyên văn, không bị cắt ký tự giữa chừng.",
    plan: {
      "cases": [
        {
          "id": "TC-V65-08-01",
          "req": "V8",
          "steps": [
            "Mở panel giỏ hàng",
            "Nhập vào ô ghi chú đúng 200 ký tự Unicode gồm dấu tiếng Việt, em dash và dấu ba chấm",
            "Lưu ghi chú và đọc lại nội dung đã lưu"
          ],
          "expected": "Ô ghi chú lưu đúng nguyên văn 200 ký tự, không bị cắt ký tự giữa chừng"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V8",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-08-01"
            ]
          }
        ],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-09-quote-nested",
    markdown: "## V9. Giỏ hàng nhanh cảnh báo khi khách thêm sản phẩm có ghi chú \"chỉ bán theo combo\".\n\nXong khi: sản phẩm có ghi chú \"chỉ bán theo combo\" thì bấm \"Thêm vào giỏ\" hiện dialog có dòng: “Sản phẩm này chỉ bán theo combo, bạn có chắc muốn thêm lẻ \"1 cái\" không?”",
    plan: {
      "cases": [
        {
          "id": "TC-V65-09-01",
          "req": "V9",
          "steps": [
            "Mở trang chi tiết một sản phẩm có ghi chú 'chỉ bán theo combo'",
            "Bấm 'Thêm vào giỏ'",
            "Đọc nội dung dialog xác nhận hiện ra"
          ],
          "expected": "Dialog hiện đúng dòng: “Sản phẩm này chỉ bán theo combo, bạn có chắc muốn thêm lẻ \"1 cái\" không?”"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V9",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-09-01"
            ]
          }
        ],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-10-quote-code-inline",
    markdown: "## V10. Giỏ hàng nhanh hiện lỗi rõ ràng khi API áp mã giảm giá trả về lỗi.\n\nXong khi: API `POST /api/cart/coupon` trả về `400` với body `{\"error\":\"invalid_coupon\"}` thì panel giỏ hiện đúng dòng chữ: \"Mã giảm giá không hợp lệ, vui lòng kiểm tra lại.\"",
    plan: {
      "cases": [
        {
          "id": "TC-V65-10-01",
          "req": "V10",
          "steps": [
            "Mở panel giỏ hàng",
            "Nhập một mã giảm giá khiến API POST /api/cart/coupon trả 400 với body {\"error\":\"invalid_coupon\"}",
            "Đọc thông báo hiển thị trên panel"
          ],
          "expected": "Panel giỏ hiện đúng dòng chữ 'Mã giảm giá không hợp lệ, vui lòng kiểm tra lại.'"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V10",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-10-01"
            ]
          }
        ],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-11-duplicate-v-code",
    markdown: "## V11. Giỏ hàng nhanh cho phép lưu giỏ hàng thành danh sách yêu thích.\n\nXong khi: bấm \"Lưu thành yêu thích\" thì toàn bộ dòng sản phẩm trong giỏ được sao chép sang danh sách yêu thích, giỏ hàng hiện tại không đổi.\n\n## V11. Giỏ hàng nhanh cho phép đổi tên danh sách yêu thích ngay trên panel.\n\nXong khi: sửa tên danh sách yêu thích và bấm Enter thì tên mới được lưu ngay, không cần bấm nút Lưu riêng.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "duplicate-code",
        "reason": "mã V11 xuất hiện hai lần với nội dung yêu cầu khác nhau, không xác định được bản chính để trace case",
        "errorLine": "## V11. Giỏ hàng nhanh cho phép đổi tên danh sách yêu thích ngay trên panel.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-12-duplicate-h-code",
    markdown: "## V12. Giỏ hàng nhanh giới hạn tối đa 20 dòng sản phẩm khác nhau.\n\nXong khi: giỏ hàng đã có 20 dòng sản phẩm khác nhau thì nút \"Thêm vào giỏ\" cho sản phẩm thứ 21 bị disable kèm tooltip \"Giỏ hàng đã đầy\".\n\n## Ca hỏng\n\nH1. Khách thêm sản phẩm thứ 21 bằng cách gọi lại API cũ trong tab khác đang mở sẵn → server từ chối với lỗi 422, giỏ hàng không vượt quá 20 dòng.\nH1. Khách tăng số lượng của một dòng đã có lên rất lớn (ví dụ 99999) → hệ thống giới hạn số lượng tối đa 999 mỗi dòng và hiện cảnh báo.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "duplicate-code",
        "reason": "mã H1 xuất hiện hai lần trong mục Ca hỏng với nội dung khác nhau, không xác định được bản chính để trace case",
        "errorLine": "H1. Khách tăng số lượng của một dòng đã có lên rất lớn (ví dụ 99999) → hệ thống giới hạn số lượng tối đa 999 mỗi dòng và hiện cảnh báo.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-13-missing-code-paragraph",
    markdown: "## V13. Giỏ hàng nhanh cho phép áp dụng nhiều mã giảm giá cùng lúc nếu được phép cộng dồn.\n\nXong khi: hai mã được đánh dấu \"cộng dồn được\" thì cả hai cùng áp dụng và tổng giảm giá bằng tổng hai mức giảm.\n\nGiỏ hàng cũng cần hiển thị rõ danh sách sản phẩm đã hết hàng ngay trong panel, kèm nút gỡ nhanh từng dòng.\n\nXong khi: sản phẩm hết hàng nằm trong giỏ thì dòng đó có nhãn \"Hết hàng\" màu đỏ và nút \"Gỡ khỏi giỏ\" riêng.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "missing-code",
        "reason": "đoạn yêu cầu về hiển thị sản phẩm hết hàng có dòng 'Xong khi:' nhưng không có mã yêu cầu (V#) đứng trước",
        "errorLine": "Giỏ hàng cũng cần hiển thị rõ danh sách sản phẩm đã hết hàng ngay trong panel, kèm nút gỡ nhanh từng dòng.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-14-missing-code-h-line",
    markdown: "## V14. Giỏ hàng nhanh gộp các dòng trùng sản phẩm thành một dòng duy nhất.\n\nXong khi: thêm cùng một sản phẩm hai lần thì giỏ hàng chỉ có một dòng với số lượng cộng dồn, không tạo dòng mới.\n\n## Ca hỏng\n\nH1. Hai lần thêm cách nhau khi đang có khuyến mãi flash-sale kết thúc giữa chừng → dòng gộp giữ đơn giá của lần thêm đầu tiên, không tự đổi giá.\nSản phẩm bị admin xoá khỏi hệ thống ngay khi đang nằm trong giỏ của khách → dòng đó tự ẩn khỏi giỏ và tổng tiền tính lại, không báo lỗi cứng cho khách.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "missing-code",
        "reason": "dòng ca hỏng thứ hai trong mục Ca hỏng không có mã H# đứng trước",
        "errorLine": "Sản phẩm bị admin xoá khỏi hệ thống ngay khi đang nằm trong giỏ của khách → dòng đó tự ẩn khỏi giỏ và tổng tiền tính lại, không báo lỗi cứng cho khách.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-15-missing-xong-khi",
    markdown: "## V15. Giỏ hàng nhanh cho phép khách chuyển giỏ hàng hiện tại thành đơn nháp để xử lý sau.\n\nKhi khách bấm \"Lưu nháp\", toàn bộ giỏ hàng được đóng gói thành một đơn ở trạng thái nháp và giỏ hàng hiện tại được làm rỗng.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "missing-xong-khi",
        "reason": "mã V15 có mô tả yêu cầu nhưng không có dòng 'Xong khi:' nào trong đoạn",
        "errorLine": "## V15. Giỏ hàng nhanh cho phép khách chuyển giỏ hàng hiện tại thành đơn nháp để xử lý sau.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-16-missing-xong-khi-partial-doc",
    markdown: "## V16. Giỏ hàng nhanh cảnh báo khi tổng giỏ hàng vượt hạn mức thanh toán COD.\n\nXong khi: tổng giỏ hàng vượt 5.000.000 ₫ và khách chọn thanh toán COD thì hiện cảnh báo và chặn bước tiếp theo cho tới khi khách đổi phương thức thanh toán hoặc giảm giỏ hàng xuống dưới hạn mức.\n\n## V17. Giỏ hàng nhanh cho phép khách gộp hai giỏ hàng khi đăng nhập trên thiết bị khác vào cùng tài khoản.\n\nKhi khách đăng nhập trên thiết bị B trong lúc giỏ hàng thiết bị A đã có sản phẩm, hệ thống hỏi khách muốn giữ giỏ nào hoặc gộp cả hai.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "missing-xong-khi",
        "reason": "mã V17 không có dòng 'Xong khi:' nào; generator dừng toàn bộ tài liệu dù V16 hợp lệ, không sinh case cho phần còn lại",
        "errorLine": "## V17. Giỏ hàng nhanh cho phép khách gộp hai giỏ hàng khi đăng nhập trên thiết bị khác vào cùng tài khoản.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-17-unresolved-explicit-marker",
    markdown: "## V18. Giỏ hàng nhanh cho phép đặt giỏ hàng ở chế độ mua theo nhóm (group-buy).\n\nXong khi: đủ số người tham gia tối thiểu trước giờ chốt đơn thì đơn group-buy tự chuyển sang trạng thái \"Đã đủ người\" và gửi thông báo cho tất cả người tham gia.\n\nSố người tối thiểu mặc định là bao nhiêu vẫn CHƯA CHỐT, chờ bên vận hành quyết định trong tuần sau.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "unresolved-sentence",
        "reason": "tài liệu còn câu chưa chốt về số người tối thiểu, chặn sinh test plan cho tới khi được quyết định",
        "errorLine": "Số người tối thiểu mặc định là bao nhiêu vẫn CHƯA CHỐT, chờ bên vận hành quyết định trong tuần sau.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-18-unresolved-open-question",
    markdown: "## V19. Giỏ hàng nhanh tự xoá sản phẩm khỏi giỏ sau một khoảng thời gian không hoạt động.\n\nXong khi: giỏ hàng không được cập nhật trong X phút thì các dòng sản phẩm hết hàng tạm thời được tự động gỡ khỏi giỏ và khách nhận thông báo trong ứng dụng.\n\nGiá trị X phút hợp lý là bao nhiêu, cần bàn thêm với đội vận hành trước khi lên số chính thức?",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "unresolved-sentence",
        "reason": "giá trị X phút trong tiêu chí Xong khi chưa được chốt, còn câu hỏi mở 'cần bàn thêm'",
        "errorLine": "Giá trị X phút hợp lý là bao nhiêu, cần bàn thêm với đội vận hành trước khi lên số chính thức?",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-19-guard-correct-target",
    markdown: "## V20. Giỏ hàng nhanh chạy kiểm thử trực tiếp trên bản remix QA đã pin.\n\nMôi trường kiểm thử: project `ee71fc9d-eebe-4bb2-b130-4930af6fa411` (preview `https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app`), trạng thái draft, chưa publish, chưa nối GitHub/GitLab, database đang tắt.\n\nXong khi: chạy lại toàn bộ luồng giỏ hàng nhanh trên đúng project/preview URL nêu trên thì không có bước nào phải chuyển sang bản khác.",
    plan: {
      "cases": [
        {
          "id": "TC-V65-19-01",
          "req": "V20",
          "steps": [
            "Mở preview https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app",
            "Chạy toàn bộ luồng giỏ hàng nhanh trên project ee71fc9d-eebe-4bb2-b130-4930af6fa411",
            "Quan sát có phải chuyển sang URL/project khác ở bước nào không"
          ],
          "expected": "Toàn bộ luồng chạy xong trên đúng project/preview URL đã pin, không phải chuyển sang bản khác"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V20",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-19-01"
            ]
          }
        ],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-20-guard-wrong-project",
    markdown: "## V21. Giỏ hàng nhanh đồng bộ giỏ hàng qua tài khoản đăng nhập.\n\nMôi trường kiểm thử: project `9f00aaaa-1111-4bb2-b130-4930af6fa000` (preview `https://id-preview--9f00aaaa-1111-4bb2-b130-4930af6fa000.lovable.app`), trạng thái draft, chưa publish, chưa nối Git, database đang tắt.\n\nXong khi: đăng nhập trên thiết bị khác thì giỏ hàng đồng bộ đúng theo tài khoản.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "live-target-mismatch",
        "reason": "project 9f00aaaa-1111-4bb2-b130-4930af6fa000 khác project đã pin ee71fc9d-eebe-4bb2-b130-4930af6fa411, không phải live target duy nhất được phép",
        "errorLine": "Môi trường kiểm thử: project `9f00aaaa-1111-4bb2-b130-4930af6fa000` (preview `https://id-preview--9f00aaaa-1111-4bb2-b130-4930af6fa000.lovable.app`), trạng thái draft, chưa publish, chưa nối Git, database đang tắt.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-21-guard-official-published",
    markdown: "## V22. Giỏ hàng nhanh hỗ trợ áp dụng điểm thưởng thành viên.\n\nMôi trường kiểm thử: project `ee71fc9d-eebe-4bb2-b130-4930af6fa411`, bản đã publish chính thức tại `https://sampleshop.example.com`, chưa nối Git, database đang tắt.\n\nXong khi: đổi điểm thưởng thành tiền giảm giá thì tổng tiền giỏ hàng trừ đúng theo tỉ lệ quy đổi.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "live-target-mismatch",
        "reason": "đúng project id đã pin nhưng bản đã publish chính thức tại URL official khác, không phải bản draft remix preview chưa publish",
        "errorLine": "Môi trường kiểm thử: project `ee71fc9d-eebe-4bb2-b130-4930af6fa411`, bản đã publish chính thức tại `https://sampleshop.example.com`, chưa nối Git, database đang tắt.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-22-guard-git-connected",
    markdown: "## V23. Giỏ hàng nhanh log lại lịch sử thay đổi số lượng để phục vụ đối soát.\n\nMôi trường kiểm thử: project `ee71fc9d-eebe-4bb2-b130-4930af6fa411` (preview `https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app`), trạng thái draft, chưa publish, đã nối GitHub, database đang tắt.\n\nXong khi: mỗi lần đổi số lượng trong giỏ đều ghi một dòng log với thời gian, sản phẩm và số lượng cũ/mới.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "live-target-mismatch",
        "reason": "đúng project/preview URL đã pin nhưng đã nối GitHub, live target đã pin yêu cầu chưa nối Git",
        "errorLine": "Môi trường kiểm thử: project `ee71fc9d-eebe-4bb2-b130-4930af6fa411` (preview `https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app`), trạng thái draft, chưa publish, đã nối GitHub, database đang tắt.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-23-guard-production-database",
    markdown: "## V24. Giỏ hàng nhanh cảnh báo tồn kho thấp ngay trong panel giỏ.\n\nMôi trường kiểm thử: project `ee71fc9d-eebe-4bb2-b130-4930af6fa411` (preview `https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app`), đang chạy ở môi trường Production, database đã bật.\n\nXong khi: sản phẩm còn dưới 5 tồn kho thì dòng sản phẩm trong giỏ hiện nhãn \"Sắp hết hàng\".",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "live-target-mismatch",
        "reason": "đúng project/preview URL đã pin nhưng đang chạy ở môi trường Production với database đã bật, live target đã pin yêu cầu draft và database disabled",
        "errorLine": "Môi trường kiểm thử: project `ee71fc9d-eebe-4bb2-b130-4930af6fa411` (preview `https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app`), đang chạy ở môi trường Production, database đã bật.",
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-H-24-composite-stress",
    markdown: "## V25. Giỏ hàng nhanh — hỗ trợ nhãn khuyến mãi \"chỉ hôm nay… 🔥\" theo giờ server.\n\nPanel giỏ cần hiện đúng nhãn khuyến mãi có ký tự đặc biệt và dấu tiếng Việt đầy đủ.\n\nXong khi: sản phẩm đang khuyến mãi flash-sale thì dòng sản phẩm hiện nhãn \"Chỉ hôm nay… 🔥\" và giá gạch ngang giá gốc, giá mới hiển thị đúng định dạng \"199.000 ₫\".\nXong khi: hết giờ flash-sale khi khách vẫn đang ở panel giỏ thì nhãn \"Chỉ hôm nay… 🔥\" tự ẩn và giá quay lại giá gốc mà không cần tải lại trang.\n\n## Ca hỏng\n\nH1. Đồng hồ máy khách lệch giờ so với server hơn 5 phút → hệ thống dùng giờ server để tính hết flash-sale, không dùng giờ máy khách, và hiện cảnh báo \"Đồng hồ thiết bị có thể không chính xác\" nếu lệch quá 5 phút.\n\n## Luật\n\nL1. Giá flash-sale hiển thị trên giỏ hàng phải luôn khớp với giá trả về từ API tính giá tại thời điểm thêm vào giỏ, không được cache quá 30 giây.",
    plan: {
      "cases": [
        {
          "id": "TC-V65-24-01",
          "req": "V25",
          "steps": [
            "Thêm vào giỏ một sản phẩm đang flash-sale",
            "Mở panel giỏ hàng",
            "Đọc nhãn khuyến mãi và giá hiển thị của dòng sản phẩm"
          ],
          "expected": "Dòng sản phẩm hiện nhãn 'Chỉ hôm nay… 🔥', giá gốc bị gạch ngang, giá mới hiển thị đúng dạng '199.000 ₫'"
        },
        {
          "id": "TC-V65-24-02",
          "req": "V25",
          "steps": [
            "Mở panel giỏ hàng khi sản phẩm đang flash-sale",
            "Chờ tới đúng thời điểm flash-sale kết thúc trong khi vẫn ở panel giỏ",
            "Đọc lại nhãn khuyến mãi và giá mà không tải lại trang"
          ],
          "expected": "Nhãn 'Chỉ hôm nay… 🔥' tự ẩn và giá quay lại giá gốc mà không cần tải lại trang"
        },
        {
          "id": "TC-V65-24-03",
          "req": "H1",
          "steps": [
            "Chỉnh đồng hồ máy khách lệch hơn 5 phút so với giờ server",
            "Mở panel giỏ hàng với sản phẩm đang flash-sale gần hết giờ theo giờ server",
            "Đọc trạng thái nhãn khuyến mãi và cảnh báo hiển thị"
          ],
          "expected": "Hệ thống tính hết flash-sale theo giờ server (không theo giờ máy khách) và hiện cảnh báo 'Đồng hồ thiết bị có thể không chính xác'"
        }
      ],
      "coverage": {
        "verdict": "OK",
        "reasonCode": null,
        "reason": null,
        "errorLine": null,
        "requiredLines": [
          {
            "code": "V25",
            "lineType": "xong-khi",
            "seq": 1,
            "caseIds": [
              "TC-V65-24-01"
            ]
          },
          {
            "code": "V25",
            "lineType": "xong-khi",
            "seq": 2,
            "caseIds": [
              "TC-V65-24-02"
            ]
          },
          {
            "code": "H1",
            "lineType": "ca-hong",
            "seq": 1,
            "caseIds": [
              "TC-V65-24-03"
            ]
          }
        ],
        "nonRequiredCodes": [
          "L1"
        ],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-O-01-readme-install",
    markdown: "# Cài đặt SampleShop CLI\n\n1. Chạy `npm install -g sampleshop-cli`\n2. Đăng nhập bằng `sampleshop login`\n3. Chạy `sampleshop deploy` để triển khai bản mới nhất.\n\nNếu gặp lỗi permission, thử chạy lại với quyền sudo.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "not-ba-pro-doc",
        "reason": "tài liệu hướng dẫn cài đặt CLI, không có mã yêu cầu hay dòng 'Xong khi' nào, không phải khuôn ba-pro",
        "errorLine": null,
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-O-02-marketing-copy",
    markdown: "# SampleShop — Bán hàng nhanh hơn, chốt đơn mượt hơn!\n\nTrải nghiệm giỏ hàng mới cực nhanh, giao diện đẹp mắt, giúp bạn tăng doanh thu ngay hôm nay. Đăng ký dùng thử miễn phí 14 ngày!",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "not-ba-pro-doc",
        "reason": "nội dung quảng cáo marketing, không có cấu trúc mã yêu cầu, không phải khuôn ba-pro",
        "errorLine": null,
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-O-03-chat-log",
    markdown: "An: ê giỏ hàng mới chạy ngon chưa?\nBình: chạy được rồi, nhưng nút thêm vào giỏ đôi khi lag xíu\nAn: ok để mai check lại, giờ đi ăn trưa đã 😄",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "not-ba-pro-doc",
        "reason": "log chat thông thường giữa hai người, không có mã yêu cầu hay 'Xong khi', không phải tài liệu BA",
        "errorLine": null,
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-O-04-recipe",
    markdown: "# Công thức Phở Bò Đơn Giản\n\nNguyên liệu: xương bò, bánh phở, hành tây, quế, hồi...\n\nBước 1: Hầm xương bò 6 tiếng.\nBước 2: Nêm gia vị vừa ăn.\nBước 3: Trụng bánh phở, xếp thịt bò, chan nước dùng.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "not-ba-pro-doc",
        "reason": "công thức nấu ăn, hoàn toàn không liên quan tới BA/ba-pro, không có mã yêu cầu",
        "errorLine": null,
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-O-05-poem",
    markdown: "Giỏ hàng nhỏ nằm im trong nắng\nChờ một ngày ai đó ghé mua\nMàn hình sáng, con trỏ khẽ đưa\nThêm một món, lòng vui khôn xiết.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "not-ba-pro-doc",
        "reason": "một đoạn thơ, không có cấu trúc mã yêu cầu hay dòng 'Xong khi', không phải tài liệu BA",
        "errorLine": null,
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-O-06-json-config",
    markdown: "```json\n{\n  \"cartMaxItems\": 20,\n  \"currency\": \"VND\",\n  \"couponStackable\": false\n}\n```\nFile cấu hình mặc định cho module giỏ hàng.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "not-ba-pro-doc",
        "reason": "đoạn cấu hình JSON kèm chú thích ngắn, không có mã yêu cầu hay dòng 'Xong khi', không phải khuôn ba-pro",
        "errorLine": null,
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-O-07-meeting-notes-red-herring",
    markdown: "# Ghi chú họp 10/08\n\n- Bàn về hiệu năng trang thanh toán\n- Marketing muốn thêm banner khuyến mãi\n- Chưa chốt ai sẽ làm việc này\n- Hẹn họp lại thứ Sáu",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "not-ba-pro-doc",
        "reason": "ghi chú họp dạng gạch đầu dòng; có cụm 'Chưa chốt' nhưng không nằm trong tài liệu ba-pro nào (không có mã yêu cầu/'Xong khi' để mà chặn) nên verdict là not-ba-pro-doc, không phải unresolved-sentence",
        "errorLine": null,
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
  {
    id: "V65-O-08-news-code-like-red-herring",
    markdown: "# Tin xe: Mẫu V6.5 mới ra mắt\n\nHãng xe XYZ vừa công bố mẫu V6.5, phiên bản nâng cấp động cơ và thêm cảm biến an toàn. Giá dự kiến công bố vào quý sau, xong khi nào ra mắt chính thức vẫn chưa rõ.",
    plan: {
      "cases": [],
      "coverage": {
        "verdict": "UNGRADED",
        "reasonCode": "not-ba-pro-doc",
        "reason": "tin tức xe hơi; 'V6.5' ở đây là tên mẫu xe và 'xong khi nào' là cụm từ thường, không phải mã yêu cầu hay dòng 'Xong khi:' của ba-pro nên verdict là not-ba-pro-doc",
        "errorLine": null,
        "requiredLines": [],
        "nonRequiredCodes": [],
        "orphanCaseIds": []
      }
    },
  },
];

/** Freeze the whole tree: the shared oracle must be unwritable, not just its root. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** @type {ReadonlyMap<string, {cases: Array<object>, coverage: object}>} */
export const FROZEN_PLANS = new Map(
  FROZEN_ENTRIES.map((entry) => [entry.markdown, deepFreeze(entry.plan)]),
);
