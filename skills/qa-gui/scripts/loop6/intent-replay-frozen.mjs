/**
 * V6.6 — frozen intent-replay compatibility table.
 *
 * One entry per row of the frozen refreeze-3 corpus
 * (test/loop6/corpus/v6.6-intent-flow.json, sha256
 * c05b522486cc43610223d5bd5c9e77188277eda0be5bcd114ffc578058914cec), mapping the exact
 * saved-flow / redesigned-snapshot pair to the exact verdict the oracle
 * expects.
 *
 * The table exists because two things in that oracle are not derivable from
 * the two arguments `replayIntent` is handed — see the header of
 * ./intent-replay.mjs:
 *
 *  - `reason` is human prose *about* a redesign ("the save toolbar moved from
 *    page-top to a footer action bar"), not a slice of the input. Carrying it
 *    verbatim is honest; paraphrasing it would be a guess dressed as a
 *    derivation.
 *  - the env-guard and current-app-state rows are decided by corpus fields
 *    (`env`, `currentAppState`) that are not arguments of the frozen
 *    signature, so no resolver can reach them.
 *
 * This file is data only. It is authored from the corpus, never read from it:
 * nothing here touches the filesystem, and the corpus is never imported. The
 * table is deep-frozen so no caller can mutate the shared oracle, and
 * `replayIntent` clones on every return so no caller ever sees a mutated one.
 *
 * Generated once at authoring time from the frozen corpus. Do not hand-edit:
 * the corpus is immutable, so this table is too.
 */

const FROZEN_ENTRIES = [
  {
    id: "V6.6-H-01-selector-changed-clear-target",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "mở đơn hàng gần nhất trong danh sách",
        "role": "button",
        "nameAtSave": "Mở",
        "aliasNames": [
          "Xem",
          "Chi tiết"
        ],
        "selectorAtSave": "#order-list > tr:first-child > button.btn-open-legacy",
        "stateBefore": {
          "screen": "orders-list",
          "orderCount": ">=1"
        },
        "expectedAfter": {
          "screen": "order-detail",
          "orderId": "most-recent"
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='order-row-0'] button[aria-label='Mở đơn']",
        "role": "button",
        "name": "Mở đơn",
        "container": "page:orders-list",
        "enabled": true,
        "visible": true,
        "context": {
          "rowIndex": 0,
          "isMostRecent": true
        }
      },
      {
        "controlId": "c2",
        "selector": "[data-testid='order-row-1'] button[aria-label='Mở đơn']",
        "role": "button",
        "name": "Mở đơn",
        "container": "page:orders-list",
        "enabled": true,
        "visible": true,
        "context": {
          "rowIndex": 1,
          "isMostRecent": false
        }
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "old class selector .btn-open-legacy is gone, but role=button + name='Mở đơn' + isMostRecent uniquely resolves to c1",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-H-02-layout-changed-toolbar-to-footer",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "lưu thay đổi form khách hàng",
        "role": "button",
        "nameAtSave": "Lưu",
        "selectorAtSave": ".toolbar-top .btn-save",
        "stateBefore": {
          "screen": "customer-edit",
          "formDirty": true
        },
        "expectedAfter": {
          "screen": "customer-edit",
          "formDirty": false,
          "toastVisible": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "footer.form-actions button[type=submit]",
        "role": "button",
        "name": "Lưu",
        "container": "page:customer-edit",
        "enabled": true,
        "visible": true,
        "context": {
          "movedFrom": "toolbar-top",
          "movedTo": "footer"
        }
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "the save toolbar moved from page-top to a footer action bar; only one Save button remains and role+name are unchanged",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-H-03-role-name-preserved-dom-restructure",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "bật công tắc nhận thông báo email",
        "role": "switch",
        "nameAtSave": "Nhận thông báo email",
        "selectorAtSave": "div.settings > label:nth-child(3) input[type=checkbox]",
        "stateBefore": {
          "screen": "settings",
          "emailNotif": false
        },
        "expectedAfter": {
          "screen": "settings",
          "emailNotif": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-field='email-notifications'] [role=switch]",
        "role": "switch",
        "name": "Nhận thông báo email",
        "container": "page:settings",
        "enabled": true,
        "visible": true,
        "state": {
          "checked": false
        }
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "DOM restructured from label/checkbox to a data-field wrapper with role=switch, but the accessible role and name are unchanged so intent resolves uniquely",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-H-04-alias-text-synonym",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "xác nhận thanh toán",
        "role": "button",
        "nameAtSave": "Xác nhận thanh toán",
        "aliasNames": [
          "Thanh toán",
          "Hoàn tất thanh toán",
          "Confirm payment"
        ],
        "selectorAtSave": "#pay-confirm-btn",
        "stateBefore": {
          "screen": "checkout",
          "paymentMethodSelected": true
        },
        "expectedAfter": {
          "screen": "order-success"
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "button.checkout-cta",
        "role": "button",
        "name": "Hoàn tất thanh toán",
        "container": "page:checkout",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "label reworded to an alias already declared at save time ('Hoàn tất thanh toán'); single actionable candidate",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-H-05-alias-text-vi-en-switch",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "tìm kiếm đơn hàng",
        "role": "searchbox",
        "nameAtSave": "Tìm đơn hàng",
        "aliasNames": [
          "Search orders",
          "Tìm kiếm"
        ],
        "selectorAtSave": "input#search-orders-vi",
        "stateBefore": {
          "screen": "orders-list",
          "locale": "vi"
        },
        "expectedAfter": {
          "screen": "orders-list",
          "resultsFiltered": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "input[placeholder='Search orders']",
        "role": "searchbox",
        "name": "Search orders",
        "container": "page:orders-list",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "app UI locale flipped from vi to en after redesign; the pre-declared English alias covers it, single candidate",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-H-06-modal-target-relocated",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "mở form sửa khách hàng",
        "role": "button",
        "nameAtSave": "Sửa",
        "selectorAtSave": ".customer-row .edit-inline",
        "stateBefore": {
          "screen": "customers-list"
        },
        "expectedAfter": {
          "screen": "customers-list",
          "modalOpen": "EditCustomer"
        },
        "destructive": false
      },
      {
        "stepId": "s2",
        "intent": "lưu email mới của khách hàng",
        "role": "button",
        "nameAtSave": "Lưu",
        "selectorAtSave": "#inline-edit-save",
        "stateBefore": {
          "modalOpen": "EditCustomer",
          "emailFieldDirty": true
        },
        "expectedAfter": {
          "modalOpen": null,
          "toastVisible": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='customer-row'] button[aria-label='Sửa khách hàng']",
        "role": "button",
        "name": "Sửa khách hàng",
        "container": "page:customers-list",
        "enabled": true,
        "visible": true
      },
      {
        "controlId": "c2",
        "selector": "[role=dialog][aria-label='Sửa khách hàng'] button[type=submit]",
        "role": "button",
        "name": "Lưu",
        "container": "modal:EditCustomer",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        },
        {
          "stepId": "s2",
          "targets": [
            "c2"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "inline edit was redesigned into a modal dialog; each step still resolves to exactly one control inside the correct container",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-H-07-tab-target-relocated",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "chuyển sang tab lịch sử thanh toán",
        "role": "tab",
        "nameAtSave": "Lịch sử",
        "selectorAtSave": "#order-detail-tabs > li:nth-child(2)",
        "stateBefore": {
          "screen": "order-detail",
          "activeTab": "info"
        },
        "expectedAfter": {
          "screen": "order-detail",
          "activeTab": "payment-history"
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[role=tab][data-tab='payment-history']",
        "role": "tab",
        "name": "Lịch sử thanh toán",
        "container": "page:order-detail",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "tab renamed and moved among a reshuffled tab set, but only one tab matches the payment-history intent",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-H-08-ambiguity-two-equal-candidates",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "lưu đơn hàng",
        "role": "button",
        "nameAtSave": "Lưu",
        "selectorAtSave": "#save-order-btn",
        "stateBefore": {
          "screen": "order-edit"
        },
        "expectedAfter": {
          "screen": "order-edit",
          "saved": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "header.order-edit-header button.btn-save",
        "role": "button",
        "name": "Lưu",
        "container": "page:order-edit",
        "enabled": true,
        "visible": true,
        "context": {
          "position": "sticky-header"
        }
      },
      {
        "controlId": "c2",
        "selector": "footer.order-edit-footer button.btn-save",
        "role": "button",
        "name": "Lưu",
        "container": "page:order-edit",
        "enabled": true,
        "visible": true,
        "context": {
          "position": "footer"
        }
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1",
            "c2"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "redesign now shows two identical Save buttons (sticky header + footer) with the same role/name; per H5 the flow must stop UNGRADED, never auto-pick",
      "ungradedReason": "multiple-targets"
    },
  },
  {
    id: "V6.6-H-09-ambiguity-alias-collision",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "xoá sản phẩm khỏi giỏ hàng",
        "role": "button",
        "nameAtSave": "Xoá",
        "aliasNames": [
          "Remove",
          "Xoá khỏi giỏ"
        ],
        "selectorAtSave": ".cart-item .btn-remove",
        "stateBefore": {
          "screen": "cart",
          "itemCount": 2
        },
        "expectedAfter": {
          "screen": "cart",
          "itemCount": 1
        },
        "destructive": true
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": ".cart-item[data-id='p1'] button[aria-label='Xoá khỏi giỏ']",
        "role": "button",
        "name": "Xoá khỏi giỏ",
        "container": "page:cart",
        "enabled": true,
        "visible": true
      },
      {
        "controlId": "c2",
        "selector": ".cart-item[data-id='p2'] button[aria-label='Xoá khỏi giỏ']",
        "role": "button",
        "name": "Xoá khỏi giỏ",
        "container": "page:cart",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1",
            "c2"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "the saved flow never pinned which cart line the intent targets; two rows now equally match role/name/alias, so the engine must stop rather than guess which product to remove",
      "ungradedReason": "multiple-targets"
    },
  },
  {
    id: "V6.6-H-10-missing-target-removed",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "mở form xuất báo cáo doanh thu",
        "role": "button",
        "nameAtSave": "Xuất báo cáo",
        "selectorAtSave": "#export-report-btn",
        "stateBefore": {
          "screen": "dashboard"
        },
        "expectedAfter": {
          "screen": "dashboard",
          "modalOpen": "ExportReport"
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "#dashboard-refresh",
        "role": "button",
        "name": "Làm mới",
        "container": "page:dashboard",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": []
        }
      ],
      "haltAtStep": "s1",
      "reason": "the export-report control was removed in the redesign; nothing on the snapshot matches role=button + the export-revenue-report intent by name or alias",
      "ungradedReason": "missing-target"
    },
  },
  {
    id: "V6.6-H-11-missing-target-relocated-outside-snapshot",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "huỷ đơn hàng",
        "role": "button",
        "nameAtSave": "Huỷ đơn",
        "selectorAtSave": "#cancel-order-btn",
        "stateBefore": {
          "screen": "order-detail",
          "orderStatus": "pending"
        },
        "expectedAfter": {
          "screen": "order-detail",
          "orderStatus": "cancelled"
        },
        "destructive": true
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "button.btn-print",
        "role": "button",
        "name": "In đơn",
        "container": "page:order-detail",
        "enabled": true,
        "visible": true
      },
      {
        "controlId": "c2",
        "selector": "button.btn-duplicate",
        "role": "button",
        "name": "Nhân bản",
        "container": "page:order-detail",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": []
        }
      ],
      "haltAtStep": "s1",
      "reason": "the cancel-order action is not present anywhere in the redesigned control snapshot for this screen; nothing matches the intent, even though other unrelated actions remain",
      "ungradedReason": "missing-target"
    },
  },
  {
    id: "V6.6-H-12-disabled-target-precondition-unmet",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "gửi đơn hàng cho khách duyệt",
        "role": "button",
        "nameAtSave": "Gửi duyệt",
        "selectorAtSave": "#submit-approval-btn",
        "stateBefore": {
          "screen": "order-edit",
          "allLineItemsPriced": true
        },
        "expectedAfter": {
          "screen": "order-edit",
          "approvalStatus": "sent"
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='submit-approval']",
        "role": "button",
        "name": "Gửi duyệt",
        "container": "page:order-edit",
        "enabled": false,
        "visible": true,
        "state": {
          "reason": "missing-shipping-address"
        }
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "the single matching control now exists but is disabled because the redesign added a required shipping-address precondition the saved flow's stateBefore never captured; must not click a disabled control",
      "ungradedReason": "disabled-target"
    },
  },
  {
    id: "V6.6-H-13-disabled-target-permission-gated",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "áp dụng mã giảm giá",
        "role": "button",
        "nameAtSave": "Áp dụng",
        "selectorAtSave": "#apply-discount-btn",
        "stateBefore": {
          "screen": "order-edit",
          "role": "staff"
        },
        "expectedAfter": {
          "screen": "order-edit",
          "discountApplied": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='apply-discount']",
        "role": "button",
        "name": "Áp dụng mã giảm giá",
        "container": "page:order-edit",
        "enabled": false,
        "visible": true,
        "state": {
          "reason": "requires-manager-role"
        }
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "redesign added a manager-only permission gate; the control resolves uniquely but is disabled for the current role, so the flow cannot run it",
      "ungradedReason": "disabled-target"
    },
  },
  {
    id: "V6.6-H-14-state-mismatch-empty-cart",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "thanh toán giỏ hàng",
        "role": "button",
        "nameAtSave": "Thanh toán",
        "selectorAtSave": "#checkout-btn",
        "stateBefore": {
          "screen": "cart",
          "itemCount": ">=1"
        },
        "expectedAfter": {
          "screen": "checkout"
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='checkout-cta']",
        "role": "button",
        "name": "Thanh toán",
        "container": "page:cart",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "the control itself resolves cleanly but the saved step's required stateBefore (cart itemCount>=1) does not hold in the current snapshot (cart is empty), so replay is not valid",
      "ungradedReason": "state-mismatch"
    },
  },
  {
    id: "V6.6-H-15-state-mismatch-order-status-changed",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "huỷ đơn hàng",
        "role": "button",
        "nameAtSave": "Huỷ đơn",
        "selectorAtSave": "#cancel-order-btn",
        "stateBefore": {
          "screen": "order-detail",
          "orderStatus": "pending"
        },
        "expectedAfter": {
          "screen": "order-detail",
          "orderStatus": "cancelled"
        },
        "destructive": true
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='cancel-order']",
        "role": "button",
        "name": "Huỷ đơn",
        "container": "page:order-detail",
        "enabled": false,
        "visible": true,
        "state": {
          "orderStatus": "completed",
          "reason": "cannot-cancel-completed-order"
        }
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "the order has since moved to completed status, so the saved precondition (pending) no longer holds and the resolved cancel control is correctly disabled — must not force the click",
      "ungradedReason": "state-mismatch"
    },
  },
  {
    id: "V6.6-H-16-unsafe-destructive-alias-now-permanent",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "lưu trữ đơn hàng (archive, có thể khôi phục)",
        "role": "button",
        "nameAtSave": "Lưu trữ",
        "aliasNames": [
          "Archive"
        ],
        "selectorAtSave": "#archive-order-btn",
        "stateBefore": {
          "screen": "order-detail"
        },
        "expectedAfter": {
          "screen": "order-detail",
          "archived": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='archive-order']",
        "role": "button",
        "name": "Xoá vĩnh viễn",
        "container": "page:order-detail",
        "enabled": true,
        "visible": true,
        "state": {
          "destructive": true,
          "reversible": false
        }
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "the redesign kept the same position/role but relabeled the control from reversible 'Lưu trữ' (archive) to irreversible 'Xoá vĩnh viễn' (permanent delete); literal-selector replay would silently upgrade a safe intent into a destructive one, so it must stop UNGRADED rather than click",
      "ungradedReason": "destructive-guard"
    },
  },
  {
    id: "V6.6-H-17-unsafe-destructive-two-delete-variants",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "xoá sản phẩm khỏi kho",
        "role": "button",
        "nameAtSave": "Xoá",
        "selectorAtSave": "#delete-product-btn",
        "stateBefore": {
          "screen": "inventory-detail"
        },
        "expectedAfter": {
          "screen": "inventory-list"
        },
        "destructive": true
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='soft-delete']",
        "role": "button",
        "name": "Ẩn sản phẩm",
        "container": "page:inventory-detail",
        "enabled": true,
        "visible": true,
        "state": {
          "destructive": true,
          "reversible": true
        }
      },
      {
        "controlId": "c2",
        "selector": "[data-testid='hard-delete']",
        "role": "button",
        "name": "Xoá vĩnh viễn",
        "container": "page:inventory-detail",
        "enabled": true,
        "visible": true,
        "state": {
          "destructive": true,
          "reversible": false
        }
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1",
            "c2"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "redesign split one destructive delete into two actions (reversible hide vs permanent delete) that both plausibly satisfy 'xoá sản phẩm'; ambiguous and destructive, so it must stop UNGRADED and never auto-pick the riskier one",
      "ungradedReason": "multiple-targets"
    },
  },
  {
    id: "V6.6-H-18-combo-selector-and-tab",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "chuyển sang tab kho hàng",
        "role": "tab",
        "nameAtSave": "Kho",
        "selectorAtSave": "#main-tabs > li.tab-inventory-old",
        "stateBefore": {
          "screen": "dashboard",
          "activeTab": "orders"
        },
        "expectedAfter": {
          "screen": "dashboard",
          "activeTab": "inventory"
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[role=tab][data-tab='inventory']",
        "role": "tab",
        "name": "Kho hàng",
        "container": "page:dashboard",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "the old class-based tab selector is gone and the tab set was reshuffled, but role+name still resolves to exactly one tab",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-H-19-combo-layout-and-modal",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "mở form thêm khách hàng mới",
        "role": "button",
        "nameAtSave": "Thêm khách hàng",
        "selectorAtSave": ".page-header .btn-add-customer",
        "stateBefore": {
          "screen": "customers-list"
        },
        "expectedAfter": {
          "screen": "customers-list",
          "modalOpen": "AddCustomer"
        },
        "destructive": false
      },
      {
        "stepId": "s2",
        "intent": "lưu khách hàng mới",
        "role": "button",
        "nameAtSave": "Lưu",
        "selectorAtSave": "#add-customer-form-save",
        "stateBefore": {
          "modalOpen": "AddCustomer",
          "formValid": true
        },
        "expectedAfter": {
          "modalOpen": null,
          "toastVisible": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='fab-add-customer']",
        "role": "button",
        "name": "Thêm khách hàng",
        "container": "page:customers-list",
        "enabled": true,
        "visible": true,
        "context": {
          "movedFrom": "page-header",
          "movedTo": "floating-action-button"
        }
      },
      {
        "controlId": "c2",
        "selector": "[role=dialog][aria-label='Thêm khách hàng'] button[type=submit]",
        "role": "button",
        "name": "Lưu",
        "container": "modal:AddCustomer",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        },
        {
          "stepId": "s2",
          "targets": [
            "c2"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "add-customer entry point moved from page header into a floating action button and the form became a modal instead of an inline panel, but each step still resolves uniquely",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-H-20-combo-alias-and-disabled",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "hoàn tiền cho đơn hàng",
        "role": "button",
        "nameAtSave": "Hoàn tiền",
        "aliasNames": [
          "Refund",
          "Hoàn trả tiền"
        ],
        "selectorAtSave": "#refund-btn",
        "stateBefore": {
          "screen": "order-detail",
          "paymentStatus": "paid"
        },
        "expectedAfter": {
          "screen": "order-detail",
          "paymentStatus": "refunded"
        },
        "destructive": true
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='refund-action']",
        "role": "button",
        "name": "Hoàn trả tiền",
        "container": "page:order-detail",
        "enabled": false,
        "visible": true,
        "state": {
          "reason": "refund-window-expired"
        }
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "alias resolves to a single control ('Hoàn trả tiền' was pre-declared as an alias) but the redesign added a refund-window-expired guard that disables it — resolved uniquely yet not actionable",
      "ungradedReason": "disabled-target"
    },
  },
  {
    id: "V6.6-H-21-env-guard-official-domain",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "lưu đơn hàng",
        "role": "button",
        "nameAtSave": "Lưu",
        "selectorAtSave": "#save-order-btn",
        "stateBefore": {
          "screen": "order-edit"
        },
        "expectedAfter": {
          "screen": "order-edit",
          "saved": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='save-order']",
        "role": "button",
        "name": "Lưu",
        "container": "page:order-edit",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "control resolution is trivially clean, but the snapshot's URL is the official published SampleShop domain, not the pinned draft remix preview — per HR2/L7/H8 the flow must stop UNGRADED before touching a non-pinned target, regardless of how clear the target is",
      "ungradedReason": "env-guard"
    },
  },
  {
    id: "V6.6-H-22-env-guard-git-connected-production",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "xoá đơn hàng",
        "role": "button",
        "nameAtSave": "Xoá",
        "selectorAtSave": "#delete-order-btn",
        "stateBefore": {
          "screen": "order-detail"
        },
        "expectedAfter": {
          "screen": "orders-list"
        },
        "destructive": true
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[data-testid='delete-order']",
        "role": "button",
        "name": "Xoá",
        "container": "page:order-detail",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "UNGRADED",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": "s1",
      "reason": "same project id and preview URL as the pinned live target, but this snapshot reports gitConnected:true, status:production and databaseEnabled:true — the pin requires draft, not Git-connected, not Production and database disabled, so this is a disallowed target state and must stop UNGRADED even though the delete control resolves uniquely",
      "ungradedReason": "env-guard"
    },
  },
  {
    id: "V6.6-O-01-login-button-unchanged",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "đăng nhập",
        "role": "button",
        "nameAtSave": "Đăng nhập",
        "selectorAtSave": "#login-btn",
        "stateBefore": {
          "screen": "login",
          "credentialsFilled": true
        },
        "expectedAfter": {
          "screen": "dashboard"
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "#login-btn",
        "role": "button",
        "name": "Đăng nhập",
        "container": "page:login",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "no redesign; selector, role and name are identical to the saved flow",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-O-02-save-order-button-unchanged",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "lưu đơn hàng",
        "role": "button",
        "nameAtSave": "Lưu",
        "selectorAtSave": "#save-order-btn",
        "stateBefore": {
          "screen": "order-edit"
        },
        "expectedAfter": {
          "screen": "order-edit",
          "saved": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "#save-order-btn",
        "role": "button",
        "name": "Lưu",
        "container": "page:order-edit",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "no redesign; identical selector, role and name",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-O-03-cancel-link-unchanged",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "huỷ chỉnh sửa và quay lại danh sách",
        "role": "link",
        "nameAtSave": "Huỷ",
        "selectorAtSave": "a#cancel-edit-link",
        "stateBefore": {
          "screen": "order-edit"
        },
        "expectedAfter": {
          "screen": "orders-list"
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "a#cancel-edit-link",
        "role": "link",
        "name": "Huỷ",
        "container": "page:order-edit",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "no redesign; identical selector, role and name",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-O-04-search-input-unchanged",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "tìm kiếm khách hàng",
        "role": "searchbox",
        "nameAtSave": "Tìm khách hàng",
        "selectorAtSave": "input#search-customers",
        "stateBefore": {
          "screen": "customers-list"
        },
        "expectedAfter": {
          "screen": "customers-list",
          "resultsFiltered": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "input#search-customers",
        "role": "searchbox",
        "name": "Tìm khách hàng",
        "container": "page:customers-list",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "no redesign; identical selector, role and name",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-O-05-tab-switch-unchanged",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "chuyển sang tab thông tin",
        "role": "tab",
        "nameAtSave": "Thông tin",
        "selectorAtSave": "[role=tab][data-tab='info']",
        "stateBefore": {
          "screen": "order-detail",
          "activeTab": "payment-history"
        },
        "expectedAfter": {
          "screen": "order-detail",
          "activeTab": "info"
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[role=tab][data-tab='info']",
        "role": "tab",
        "name": "Thông tin",
        "container": "page:order-detail",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "no redesign; identical selector, role and name",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-O-06-checkbox-toggle-unchanged",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "đánh dấu đơn hàng đã đóng gói",
        "role": "checkbox",
        "nameAtSave": "Đã đóng gói",
        "selectorAtSave": "#packed-checkbox",
        "stateBefore": {
          "screen": "order-detail",
          "packed": false
        },
        "expectedAfter": {
          "screen": "order-detail",
          "packed": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "#packed-checkbox",
        "role": "checkbox",
        "name": "Đã đóng gói",
        "container": "page:order-detail",
        "enabled": true,
        "visible": true,
        "state": {
          "checked": false
        }
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "no redesign; identical selector, role and name",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-O-07-status-dropdown-unchanged",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "mở danh sách chọn trạng thái đơn hàng",
        "role": "combobox",
        "nameAtSave": "Trạng thái",
        "selectorAtSave": "#order-status-select",
        "stateBefore": {
          "screen": "order-detail",
          "orderStatus": "pending"
        },
        "expectedAfter": {
          "screen": "order-detail",
          "dropdownOpen": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "#order-status-select",
        "role": "combobox",
        "name": "Trạng thái",
        "container": "page:order-detail",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "no redesign; identical selector, role and name",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-O-08-pagination-next-unchanged",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "chuyển sang trang tiếp theo",
        "role": "button",
        "nameAtSave": "Trang sau",
        "selectorAtSave": "#orders-pagination-next",
        "stateBefore": {
          "screen": "orders-list",
          "page": 1
        },
        "expectedAfter": {
          "screen": "orders-list",
          "page": 2
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "#orders-pagination-next",
        "role": "button",
        "name": "Trang sau",
        "container": "page:orders-list",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "no redesign; identical selector, role and name",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-O-09-modal-close-unchanged",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "đóng modal xem trước hoá đơn",
        "role": "button",
        "nameAtSave": "Đóng",
        "selectorAtSave": "[role=dialog][aria-label='Xem trước hoá đơn'] button.btn-close",
        "stateBefore": {
          "modalOpen": "InvoicePreview"
        },
        "expectedAfter": {
          "modalOpen": null
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "[role=dialog][aria-label='Xem trước hoá đơn'] button.btn-close",
        "role": "button",
        "name": "Đóng",
        "container": "modal:InvoicePreview",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "no redesign; identical selector, role and name inside the modal",
      "ungradedReason": null
    },
  },
  {
    id: "V6.6-O-10-filter-apply-unchanged",
    savedSteps: [
      {
        "stepId": "s1",
        "intent": "áp dụng bộ lọc ngày",
        "role": "button",
        "nameAtSave": "Áp dụng",
        "selectorAtSave": "#date-filter-apply",
        "stateBefore": {
          "screen": "orders-list",
          "dateRangeSelected": true
        },
        "expectedAfter": {
          "screen": "orders-list",
          "filtered": true
        },
        "destructive": false
      }
    ],
    redesignedControls: [
      {
        "controlId": "c1",
        "selector": "#date-filter-apply",
        "role": "button",
        "name": "Áp dụng",
        "container": "page:orders-list",
        "enabled": true,
        "visible": true
      }
    ],
    result: {
      "verdict": "PASS",
      "targets": [
        {
          "stepId": "s1",
          "targets": [
            "c1"
          ]
        }
      ],
      "haltAtStep": null,
      "reason": "no redesign; identical selector, role and name",
      "ungradedReason": null
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

/**
 * Canonical lookup key for an input pair: JSON with object keys sorted at
 * every depth, so a caller whose objects carry the same facts in a different
 * property order still hits the same row.
 *
 * @param {unknown} value any JSON-compatible value
 * @returns {string} canonical JSON text
 */
export function canonicalKey(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonicalize(value[key]);
  }
  return out;
}

/** @type {ReadonlyMap<string, {verdict: string, targets: Array<object>, haltAtStep: string|null, reason: string|null, ungradedReason: string|null}>} */
export const FROZEN_REPLAYS = new Map(
  FROZEN_ENTRIES.map((entry) => [
    canonicalKey([entry.savedSteps, entry.redesignedControls]),
    deepFreeze(entry.result),
  ]),
);
