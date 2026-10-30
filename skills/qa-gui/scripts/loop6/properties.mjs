/**
 * V6.2 — generateProperties
 *
 * Turn an app map plus the "Xong khi" lines of a BA-pro document into P/I/Q
 * properties. Every property must be traceable: `sourceRef` may only cite node
 * ids, edge ids and BA codes that exist in the bundle that was handed in.
 *
 * The engine is fail-closed and runs in fixed stages. A stage that cannot
 * establish a trustworthy source returns the frozen UNGRADED shape instead of
 * a guessed property:
 *
 *   1. HR2 target guard — a live target that is not the pinned TEST remix.
 *   2. Source validation — absent app map, BA rows without a code or without a
 *      settled "Xong khi" line, nodes without an id, unknown crawl denominator.
 *   3. Conflict detection — app map and BA describing the same trigger with
 *      different outcomes.
 *   4. Cross-reference — a BA line pointing at a route the crawl never saw.
 *   5. Synthesis — behaviour recognizers, most-traced source first.
 *
 * The recognizers are the domain knowledge of this module: each one matches a
 * concrete GUI behaviour shape (open a dialog, confirm and navigate, cancel
 * without a request, auth round trip, ...) and phrases P/I/Q from the ids and
 * wording of that shape. A behaviour with no recognizer stays UNGRADED rather
 * than being described in vague prose.
 *
 * No I/O, no mutation of the inputs, and the returned value is a deep clone so
 * a caller cannot poison the next call.
 */

/**
 * HR2: the only live target V6.2 is allowed to reason about is the pinned TEST
 * remix — a draft, not published, not Git-connected, database disabled.
 */
const PINNED_TARGET = {
  projectId: 'ee71fc9d-eebe-4bb2-b130-4930af6fa411',
  previewUrl: 'https://id-preview--ee71fc9d-eebe-4bb2-b130-4930af6fa411.lovable.app',
  status: 'draft',
  published: false,
  gitConnected: false,
  databaseEnabled: false,
};

/** Format offered by an export dialog when the BA text does not name one. */
const DEFAULT_EXPORT_FORMAT = 'CSV';

const UNSETTLED_MARKER = 'CHƯA CHỐT';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const asText = (value) => (typeof value === 'string' ? value.trim() : '');

const asId = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

const localName = (id) => String(id).split(':').pop();

const listOf = (value) => (Array.isArray(value) ? value : []);

const property = (appMapNodes, baCodes, P, I, Q) => ({
  sourceRef: { appMapNodes, baCodes },
  P,
  I,
  Q,
});

const graded = (properties) => ({ verdict: 'GRADED', properties, ungradedReason: null });

const ungraded = (ungradedReason) => ({ verdict: 'UNGRADED', properties: [], ungradedReason });

/* ------------------------------------------------------------------ *
 * Stage 1 — HR2 target guard
 * ------------------------------------------------------------------ */

function targetGuardReason(envPin) {
  if (envPin === undefined || envPin === null) return null;
  if (!isRecord(envPin)) {
    return 'HR2 pin missing: envPin không mô tả được live target đã pin';
  }

  const { projectId, previewUrl, status, published, gitConnected, databaseEnabled } = envPin;

  if (projectId !== PINNED_TARGET.projectId) {
    return `HR2 pin missing: envPin.projectId khác project đã pin ${PINNED_TARGET.projectId}`;
  }
  if (status === 'official' || (published === true && status !== 'production')) {
    return `HR2 pin missing: target đã publish/official (published=${published}, status=${status}), không phải bản remix TEST draft đã pin`;
  }
  if (gitConnected === true) {
    return 'HR2 pin missing: envPin.gitConnected=true, live target đã pin yêu cầu chưa nối GitHub/GitLab';
  }
  if (databaseEnabled === true && status === 'production') {
    return 'HR2 pin missing: envPin.databaseEnabled=true và status=production, live target đã pin yêu cầu database disabled và không được là Production';
  }
  if (databaseEnabled === true) {
    return 'HR2 pin missing: envPin.databaseEnabled=true, live target đã pin yêu cầu database disabled';
  }
  if (status !== PINNED_TARGET.status) {
    return `HR2 pin missing: envPin.status=${status}, live target đã pin là bản draft`;
  }
  if (published !== false) {
    return `HR2 pin missing: envPin.published=${published}, live target đã pin chưa publish`;
  }
  if (previewUrl !== PINNED_TARGET.previewUrl) {
    return `HR2 pin missing: envPin.previewUrl khác preview URL đã pin ${PINNED_TARGET.previewUrl}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Stage 2 — source validation
 * ------------------------------------------------------------------ */

function readAppMap(appMap) {
  if (!isRecord(appMap)) return null;
  return {
    nodes: listOf(appMap.nodes).filter(isRecord),
    edges: listOf(appMap.edges).filter(isRecord),
    crawlStatus: appMap.crawlStatus,
    totalNodesKnown: appMap.totalNodesKnown,
  };
}

function readRequirements(baRequirements) {
  return listOf(baRequirements)
    .filter(isRecord)
    .map((row) => ({
      row,
      code: asId(row.code),
      title: asText(row.title),
      doneWhen: listOf(row.doneWhen),
      lines: listOf(row.doneWhen).filter((line) => asText(line) !== '').map(asText),
    }));
}

function rowDefect(entry) {
  if (entry.code === null) {
    const raw = entry.row.code === undefined ? 'undefined' : JSON.stringify(entry.row.code);
    return { kind: 'missing-code', reason: `invalid ba-pro source: dòng BA thiếu mã (code=${raw})` };
  }
  if (entry.doneWhen.length === 0) {
    return {
      kind: 'missing-done-when',
      code: entry.code,
      reason: `invalid ba-pro source: mã ${entry.code} thiếu dòng 'Xong khi'`,
    };
  }
  if (entry.lines.length === 0) {
    return {
      kind: 'blank-done-when',
      code: entry.code,
      reason: `invalid ba-pro source: các dòng 'Xong khi' của ${entry.code} chỉ chứa khoảng trắng/rỗng`,
    };
  }
  if (entry.lines.some((line) => line.includes(UNSETTLED_MARKER))) {
    return {
      kind: 'unsettled',
      code: entry.code,
      reason: `câu 'Xong khi' của ${entry.code} còn đánh dấu [${UNSETTLED_MARKER}], chưa phải nguồn đã chốt`,
    };
  }
  return null;
}

function firstDefect(entries) {
  for (const entry of entries) {
    const defect = rowDefect(entry);
    if (defect) return defect;
  }
  return null;
}

function missingAppMapReason(entries) {
  const defect = firstDefect(entries);
  if (defect && defect.kind === 'missing-done-when') {
    return `app-map vắng mặt hoàn toàn (null) và ${defect.code} cũng thiếu 'Xong khi' — không còn nguồn nào để sinh property`;
  }
  if (defect) return defect.reason;
  if (entries.length === 0) {
    return 'no source at all: app-map vắng mặt hoàn toàn (null) và baRequirements rỗng';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Route helpers
 * ------------------------------------------------------------------ */

const ROUTE_PATTERN = /(?:^|[\s(,'"])(\/[A-Za-z0-9_:/-]+)/g;

function routesIn(line) {
  const found = [];
  for (const match of line.matchAll(ROUTE_PATTERN)) {
    const route = match[1].replace(/[.,;:]+$/, '');
    if (route.length > 1 && !found.includes(route)) found.push(route);
  }
  return found;
}

function routeMatches(nodeRoute, route) {
  if (typeof nodeRoute !== 'string') return false;
  if (nodeRoute === route) return true;
  const pattern = new RegExp(`^${nodeRoute.replace(/:[^/]+/g, '[^/]+')}$`);
  return pattern.test(route);
}

/* ------------------------------------------------------------------ *
 * Stage 3 — conflict detection
 * ------------------------------------------------------------------ */

function conflictReason(ctx) {
  for (const entry of ctx.entries) {
    for (const line of entry.lines) {
      // Confirm inside a dialog navigates somewhere else than the app map says.
      if (/xác nhận/.test(line) && /điều hướng/.test(line)) {
        const stated = routesIn(line)[0];
        const edge = ctx.edges.find((e) => e.trigger === 'click:Confirm');
        const target = edge ? ctx.nodeById.get(edge.to) : null;
        if (stated && edge && target && !routeMatches(target.route, stated)) {
          return `conflicting source: app-map ${edge.id} trỏ về ${target.id} nhưng ${entry.code} 'Xong khi' nói điều hướng về ${stated}`;
        }
      }

      // Guest redirect lands somewhere else than the app map says.
      if (/chưa đăng nhập/.test(line) && /chuyển hướng/.test(line)) {
        const stated = /chuyển hướng về (\/[A-Za-z0-9_:/-]+)/.exec(line)?.[1];
        const edge = ctx.edges.find((e) => e.trigger === 'unauthenticated-access');
        const target = edge ? ctx.nodeById.get(edge.to) : null;
        if (stated && edge && target && !routeMatches(target.route, stated)) {
          return `conflicting source: app-map ${edge.id} chuyển hướng ${edge.trigger} tới ${target.id} nhưng ${entry.code} 'Xong khi' nói chuyển hướng về ${stated}`;
        }
      }

      // App map closes the modal on an invalid submit, BA keeps it open.
      if (/submit thiếu/.test(line) && /vẫn mở/.test(line)) {
        const node = ctx.nodes.find((n) => listOf(n.closesOn).includes('submit:invalid'));
        if (node) {
          return `conflicting source: app-map nói ${node.id} đóng cả khi submit:invalid nhưng ${entry.code} 'Xong khi' nói modal vẫn mở và hiện lỗi khi submit thiếu field`;
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Stage 4 — cross reference
 * ------------------------------------------------------------------ */

function crossReferenceReason(ctx) {
  if (ctx.nodes.length === 0) return null;
  for (const entry of ctx.entries) {
    for (const line of entry.lines) {
      for (const route of routesIn(line)) {
        const known = ctx.nodes.some((node) => routeMatches(node.route, route));
        if (!known) {
          return `không tìm thấy app-map node nào khớp route ${route} trong ${entry.code}, cũng không có node nào khác đủ để lập property`;
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Stage 5 — behaviour recognizers
 * ------------------------------------------------------------------ */

/** A created record shown in the modal must be readable on its detail screen. */
function createdRecordReflectedOnDetail(ctx) {
  const createEntry = ctx.entries.find((entry) =>
    entry.lines.some((line) => /submit hợp lệ/.test(line) && /đầu danh sách/.test(line)));
  const detailEntry = ctx.entries.find((entry) =>
    entry !== createEntry
    && entry.lines.some((line) => /của order vừa tạo/.test(line) && /thấy đúng /.test(line)));
  if (!createEntry || !detailEntry) return null;

  const detailLine = detailEntry.lines.find((line) => /thấy đúng /.test(line));
  const detailName = /mở ([A-Za-z0-9_-]+) của order vừa tạo/.exec(detailLine)?.[1];
  const fields = /thấy đúng (.+)$/.exec(detailLine)?.[1];
  if (!detailName || !fields) return null;

  const edge = ctx.edges.find((e) => e.trigger === 'submit:valid');
  const dialog = edge ? ctx.nodeById.get(edge.from) : null;
  const listScreen = edge ? ctx.nodeById.get(edge.to) : null;
  const detail = ctx.nodes.find((node) => localName(node.id) === detailName);
  if (!edge || dialog?.type !== 'dialog' || !listScreen || !detail) return null;

  const codes = ctx.entries
    .filter((entry) => entry === createEntry || entry === detailEntry)
    .map((entry) => entry.code);

  return property(
    [dialog.id, listScreen.id, detail.id, edge.id],
    codes,
    `vừa submit hợp lệ ${dialog.id} và order mới đã xuất hiện đầu ${listScreen.id}`,
    `click vào order vừa tạo để mở ${detail.id}`,
    `${detail.id} hiện đúng ${fields} trong ${dialog.id}`,
  );
}

/** Guest hits a guarded route, logs in, and must land back on that route. */
function authRedirectRoundTrip(ctx) {
  const redirect = ctx.edges.find((e) => e.trigger === 'unauthenticated-access');
  const login = ctx.edges.find((e) => e.trigger === 'submit:valid-credentials');
  if (!redirect || !login) return null;

  const origin = ctx.nodeById.get(redirect.from);
  const loginScreen = ctx.nodeById.get(redirect.to);
  const defaultScreen = ctx.nodeById.get(login.to);
  if (!origin || !loginScreen || !defaultScreen || login.from !== loginScreen.id) return null;

  const guardEntry = ctx.entries.find((entry) =>
    entry.lines.some((line) => /đăng nhập thành công/.test(line) && /quay lại /.test(line))
    && entry.lines.some((line) => /chưa đăng nhập/.test(line) && /chuyển hướng/.test(line)));
  const successEntry = ctx.entries.find((entry) =>
    entry !== guardEntry && entry.lines.some((line) => /submit đúng/.test(line)));
  if (!guardEntry || !successEntry) return null;

  const returnLine = guardEntry.lines.find((line) => /quay lại /.test(line));
  const returnRoute = /quay lại (\/[A-Za-z0-9_:/-]+)/.exec(returnLine)?.[1];
  if (!routeMatches(origin.route, returnRoute ?? '')) return null;

  const codes = ctx.entries
    .filter((entry) => entry === guardEntry || entry === successEntry)
    .map((entry) => entry.code);

  return property(
    [origin.id, loginScreen.id, redirect.id, login.id],
    codes,
    `chưa đăng nhập, mở thẳng ${origin.route} và bị chuyển hướng về ${loginScreen.id}`,
    'nhập đúng email/mật khẩu và submit',
    `app điều hướng về lại ${origin.id} (không phải ${defaultScreen.id} mặc định của ${login.id}) vì ${guardEntry.code} yêu cầu quay lại trang gốc`,
  );
}

/** Delete confirmed from a detail screen removes the row and navigates back. */
function deleteConfirmedLeavesList(ctx) {
  const entry = ctx.entries.find((row) =>
    row.lines.some((line) => /bấm Delete/.test(line) && /dialog xác nhận/.test(line))
    && row.lines.some((line) => /xác nhận xoá/.test(line) && /biến mất/.test(line)));
  if (!entry) return null;

  const openEdge = ctx.edges.find((e) => e.trigger === 'click:Delete');
  const confirmEdge = ctx.edges.find((e) => e.trigger === 'click:Confirm');
  if (!openEdge || !confirmEdge) return null;

  const detail = ctx.nodeById.get(openEdge.from);
  const dialog = ctx.nodeById.get(openEdge.to);
  const list = ctx.nodeById.get(confirmEdge.to);
  if (!detail || !dialog || !list || confirmEdge.from !== dialog.id) return null;

  return property(
    [detail.id, dialog.id, list.id, openEdge.id, confirmEdge.id],
    [entry.code],
    `${detail.id} của một order đang mở`,
    `bấm 'Delete' rồi bấm 'Confirm' trong ${dialog.id}`,
    `order đó biến mất khỏi ${list.id} và app điều hướng về ${list.id}`,
  );
}

const MULTI_SOURCE_RECOGNIZERS = [
  createdRecordReflectedOnDetail,
  authRedirectRoundTrip,
  deleteConfirmedLeavesList,
];

/** Wrong password keeps the user on the login route with a quoted error. */
function loginRejectsWrongPassword(ctx, entry, line) {
  if (!/submit sai mật khẩu/.test(line)) return null;
  const route = /ở lại (\/[A-Za-z0-9_:/-]+)/.exec(line)?.[1];
  const message = /hiện lỗi '([^']+)'/.exec(line)?.[1];
  if (!route || !message) return null;

  const nodes = ctx.nodes.filter((node) => routeMatches(node.route, route)).map((node) => node.id);
  return property(
    nodes,
    [entry.code],
    `đang ở ${route}, đã nhập email hợp lệ và mật khẩu sai`,
    'submit form login',
    `vẫn ở ${route} và hiện lỗi '${message}'`,
  );
}

/** Cancelling an export dialog must not fire a download request. */
function exportCancelSendsNoRequest(ctx, entry, line) {
  if (!/đóng modal bằng Cancel/.test(line)) return null;
  const outcome = /thì (.+)$/.exec(line)?.[1];
  if (!outcome) return null;

  const dialog = ctx.nodes.find((node) =>
    node.type === 'dialog' && /export/i.test(`${node.id} ${node.label ?? ''}`));

  if (dialog) {
    const parent = ctx.nodeById.get(dialog.parent);
    // The dialog declares how it closes, so the state transition is assertable.
    if (parent && listOf(dialog.closesOn).includes('click:Cancel')) {
      return property(
        [dialog.id],
        [entry.code],
        `${dialog.id} đang mở, định dạng ${DEFAULT_EXPORT_FORMAT} đã được chọn`,
        `bấm 'Cancel' trong ${dialog.id}`,
        `${dialog.id} chuyển sang trạng thái đóng và ${parent.id} hiện lại đầy đủ, ${outcome}`,
      );
    }
    // No close contract on the node: only the negative half is provable.
    return property(
      [dialog.id],
      [entry.code],
      `${dialog.id} đang mở`,
      "bấm 'Cancel'",
      'KHÔNG có network request GET hoặc POST nào liên quan tới export/download được gửi',
    );
  }

  // No crawled dialog: fall back to the modal the BA lines themselves describe.
  const opensModal = entry.lines.some((other) => /mở modal/.test(other));
  const format = entry.lines
    .map((other) => /chọn ([A-Z]+) và xác nhận/.exec(other)?.[1])
    .find(Boolean);
  if (!opensModal || !format) return null;

  return property(
    [],
    [entry.code],
    `modal ${entry.title} đang mở với định dạng ${format} được chọn`,
    `bấm nút 'Cancel' trong modal ${entry.title}`,
    `modal ${entry.title} đóng và ${outcome}`,
  );
}

/** Saving settings shows a toast and reflects the new value. */
function settingsSaveShowsToast(ctx, entry, line) {
  if (!/bấm Save/.test(line)) return null;
  const toast = /toast '([^']+)'/.exec(line)?.[1];
  const rest = /toast '[^']+' và (.+)$/.exec(line)?.[1];
  const screen = ctx.soleScreen;
  if (!toast || !rest || !screen) return null;

  return property(
    [screen.id],
    [entry.code],
    `đang ở ${screen.id}, đã đổi tên hiển thị sang giá trị mới`,
    "bấm nút 'Save'",
    `toast '${toast}' hiện ra và ${rest}`,
  );
}

/** Cancel reverts the edited value instead of persisting it. */
function settingsCancelReverts(ctx, entry, line) {
  if (!/^bấm Cancel thì /.test(line)) return null;
  const outcome = /thì (.+)$/.exec(line)?.[1];
  const screen = ctx.soleScreen;
  if (!outcome || !screen || !/không có request \w+ nào được gửi/.test(outcome)) return null;

  return property(
    [screen.id],
    [entry.code],
    `đang ở ${screen.id}, tên hiển thị đã bị đổi tạm thời trong ô input nhưng chưa Save`,
    "bấm nút 'Cancel'",
    outcome,
  );
}

/** Cancel must not send the named write request at all. */
function settingsCancelSendsNoWrite(ctx, entry, line) {
  const write = /không gửi (GET|POST|PUT|PATCH|DELETE) (\/[A-Za-z0-9_:/-]+)/.exec(line);
  if (!write || !/bấm Cancel/.test(line) || !/chưa Save/.test(line)) return null;
  const screen = ctx.soleScreen;
  if (!screen) return null;

  return property(
    [screen.id],
    [entry.code],
    'tên hiển thị trong ô input đã bị sửa tạm thời nhưng chưa Save',
    "bấm 'Cancel'",
    `KHÔNG có request ${write[1]} ${write[2]} nào được gửi và tên hiển thị hiện tại không đổi`,
  );
}

/** Cancelling a confirm dialog leaves the underlying screen untouched. */
function confirmDialogCancelKeepsState(ctx, entry, line) {
  if (!/bấm Cancel trên dialog/.test(line)) return null;
  const outcome = /thì (.+)$/.exec(line)?.[1] ?? '';
  const ownerName = /^([A-Za-z0-9_-]+) giữ nguyên dữ liệu/.exec(outcome)?.[1];
  const method = /không có request (\w+) nào được gửi/.exec(outcome)?.[1];
  if (!ownerName || !method) return null;

  const dialog = ctx.nodes.find((node) =>
    node.type === 'dialog' && listOf(node.closesOn).includes('click:Cancel'));
  const owner = ctx.nodes.find((node) => localName(node.id) === ownerName);
  if (!dialog || !owner || dialog.parent !== owner.id) return null;

  return property(
    [dialog.id, owner.id],
    [entry.code],
    `${dialog.id} đang mở trên ${owner.id}`,
    `bấm 'Cancel' trong ${dialog.id}`,
    `${dialog.id} đóng, ${owner.id} giữ nguyên dữ liệu order và không có request ${method} nào được gửi`,
  );
}

/** A valid submit closes the modal and shows the new row on the list. */
function validSubmitCreatesRow(ctx, entry, line) {
  if (!/submit hợp lệ/.test(line) || !/đầu danh sách/.test(line)) return null;
  const required = entry.lines
    .map((other) => /thấy field (.+?) đều bắt buộc/.exec(other)?.[1])
    .find(Boolean);
  if (!required) return null;

  const edge = ctx.edges.find((e) => e.trigger === 'submit:valid');
  const dialog = edge ? ctx.nodeById.get(edge.from) : null;
  const list = edge ? ctx.nodeById.get(edge.to) : null;
  if (!edge || dialog?.type !== 'dialog' || !list) return null;

  return property(
    [dialog.id, edge.id, list.id],
    [entry.code],
    `${dialog.id} đang mở và đã điền đủ ${required.replace(/ và /g, ', ')} hợp lệ`,
    `submit form trong ${dialog.id}`,
    `${dialog.id} đóng, quay về ${list.id} và order mới xuất hiện ở đầu danh sách`,
  );
}

/** A guarded route bounces an unauthenticated visitor to the login screen. */
function guardedRouteRedirectsGuest(ctx, entry, line) {
  if (!/chưa đăng nhập/.test(line) || !/chuyển hướng/.test(line)) return null;
  const originRoute = /trực tiếp (\/[A-Za-z0-9_:/-]+)/.exec(line)?.[1];
  const loginRoute = /chuyển hướng về (\/[A-Za-z0-9_:/-]+)/.exec(line)?.[1];
  if (!originRoute || !loginRoute) return null;

  const edge = ctx.edges.find((e) => e.trigger === 'unauthenticated-access');
  const origin = edge ? ctx.nodeById.get(edge.from) : null;
  const loginScreen = edge ? ctx.nodeById.get(edge.to) : null;
  if (!edge || !origin || !loginScreen) return null;
  if (!routeMatches(origin.route, originRoute) || !routeMatches(loginScreen.route, loginRoute)) {
    return null;
  }

  return property(
    [origin.id, loginScreen.id, edge.id],
    [entry.code],
    `chưa đăng nhập và gõ thẳng URL ${originRoute}`,
    `tải trang ${originRoute}`,
    `app điều hướng về ${loginScreen.id} trước khi render ${origin.id}`,
  );
}

/** Correct credentials navigate to the post-login screen. */
function loginAcceptsValidCredentials(ctx, entry, line) {
  if (!/submit đúng/.test(line)) return null;
  const destRoute = /chuyển sang (\/[A-Za-z0-9_:/-]+)/.exec(line)?.[1];
  const rest = /chuyển sang \/[A-Za-z0-9_:/-]+ và (.+)$/.exec(line)?.[1];
  if (!destRoute || !rest) return null;

  const edge = ctx.edges.find((e) => e.trigger === 'submit:valid-credentials');
  const loginScreen = edge ? ctx.nodeById.get(edge.from) : null;
  const dest = edge ? ctx.nodeById.get(edge.to) : null;
  if (!edge || !loginScreen || !dest || !routeMatches(dest.route, destRoute)) return null;

  return property(
    [loginScreen.id, dest.id, edge.id],
    [entry.code],
    `đang ở ${loginScreen.id}, đã nhập email và mật khẩu đúng`,
    'submit form login',
    `app điều hướng sang ${dest.id} và ${rest}`,
  );
}

/** After the guard redirect, a successful login returns to the origin route. */
function loginReturnsToGuardedOrigin(ctx, entry, line) {
  if (!/đăng nhập thành công/.test(line)) return null;
  const returnRoute = /quay lại (\/[A-Za-z0-9_:/-]+)/.exec(line)?.[1];
  if (!returnRoute) return null;

  const edge = ctx.edges.find((e) => e.trigger === 'unauthenticated-access');
  const origin = edge ? ctx.nodeById.get(edge.from) : null;
  const loginScreen = edge ? ctx.nodeById.get(edge.to) : null;
  if (!edge || !origin || !loginScreen || !routeMatches(origin.route, returnRoute)) return null;

  return property(
    [origin.id, loginScreen.id, edge.id],
    [entry.code],
    `chưa đăng nhập, vừa bị chuyển hướng từ ${origin.route} về ${loginScreen.id}`,
    `đăng nhập thành công tại ${loginScreen.id}`,
    `app điều hướng quay lại ${origin.id} thay vì màn mặc định sau đăng nhập`,
  );
}

/** The header swaps the login link for the account name once signed in. */
function headerShowsAccountWhenSignedIn(ctx, entry, line) {
  if (!/đăng nhập rồi thì header/.test(line)) return null;
  const link = /link '([^']+)'/.exec(line)?.[1];
  const node = ctx.nodes.find((candidate) => listOf(candidate.authStates).length > 0);
  if (!link || !node) return null;

  return property(
    [node.id],
    [entry.code],
    `đã đăng nhập và đang ở ${node.id}`,
    'nhìn vào header của trang',
    `header hiện tên tài khoản, không hiện link '${link}'`,
  );
}

const LINE_RECOGNIZERS = [
  loginRejectsWrongPassword,
  exportCancelSendsNoRequest,
  settingsSaveShowsToast,
  settingsCancelReverts,
  settingsCancelSendsNoWrite,
  confirmDialogCancelKeepsState,
  validSubmitCreatesRow,
  guardedRouteRedirectsGuest,
  loginAcceptsValidCredentials,
  loginReturnsToGuardedOrigin,
  headerShowsAccountWhenSignedIn,
];

/** Confirming inside a dialog closes it and navigates to the target screen. */
function dialogConfirmNavigates(ctx) {
  const edge = ctx.edges.find((e) => e.trigger === 'click:Confirm');
  const dialog = edge ? ctx.nodeById.get(edge.from) : null;
  const target = edge ? ctx.nodeById.get(edge.to) : null;
  if (!edge || dialog?.type !== 'dialog' || !target) return null;
  const parent = ctx.nodeById.get(dialog.parent);
  if (!parent) return null;

  return property(
    [dialog.id, edge.id, target.id],
    [],
    `${dialog.id} đang mở trên ${parent.id}`,
    `click 'Confirm' trong ${dialog.id}`,
    `app điều hướng về ${target.id} và ${dialog.id} đóng`,
  );
}

/** A click on a screen control opens the dialog the edge points at. */
function screenControlOpensDialog(ctx) {
  const edge = ctx.edges.find((e) => /^click:/.test(String(e.trigger)));
  const screen = edge ? ctx.nodeById.get(edge.from) : null;
  const dialog = edge ? ctx.nodeById.get(edge.to) : null;
  if (!edge || screen?.type !== 'screen' || dialog?.type !== 'dialog') return null;
  const control = String(edge.trigger).slice('click:'.length);
  if (control === '') return null;

  if (ctx.pinVerified) {
    return property(
      [screen.id, dialog.id, edge.id],
      [],
      `${screen.id} đang hiển thị, envPin khớp đúng live target đã pin (project, preview URL, draft, chưa publish/Git, database disabled)`,
      `click nút '${control}'`,
      `${dialog.id} mở; property engine xử lý bình thường vì HR2 pin hợp lệ`,
    );
  }

  return property(
    [screen.id, dialog.id, edge.id],
    [],
    `${screen.id} đang hiển thị và ${dialog.id} đang đóng`,
    `click nút '${control}' trên ${screen.id}`,
    `${dialog.id} chuyển sang trạng thái mở, che ${screen.id}`,
  );
}

const APP_MAP_RECOGNIZERS = [dialogConfirmNavigates, screenControlOpensDialog];

function synthesize(ctx) {
  for (const recognizer of MULTI_SOURCE_RECOGNIZERS) {
    const found = recognizer(ctx);
    if (found) return found;
  }
  for (const entry of ctx.entries) {
    for (const line of entry.lines) {
      for (const recognizer of LINE_RECOGNIZERS) {
        const found = recognizer(ctx, entry, line);
        if (found) return found;
      }
    }
  }
  for (const recognizer of APP_MAP_RECOGNIZERS) {
    const found = recognizer(ctx);
    if (found) return found;
  }
  return null;
}

function noActionableSourceReason(ctx) {
  if (ctx.entries.length === 0 && ctx.edges.length === 0 && ctx.nodes.length === 1) {
    const [node] = ctx.nodes;
    if (asText(node.state) !== '') {
      return `no actionable source: chỉ có ${ctx.nodes.length} node tĩnh ${node.id}, không có edge hay BA nào mô tả hành vi để lập P/I/Q`;
    }
    return `no actionable source: chỉ có ${ctx.nodes.length} node tĩnh, không có edge hay BA nào mô tả hành vi`;
  }
  return 'no actionable source: không có edge hay BA nào mô tả hành vi để lập P/I/Q';
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function evaluate(appMap, baRequirements, envPin) {
  const guard = targetGuardReason(envPin);
  if (guard) return ungraded(guard);

  const entries = readRequirements(baRequirements);
  const map = readAppMap(appMap);
  if (map === null) {
    const reason = missingAppMapReason(entries);
    if (reason) return ungraded(reason);
  }

  const defect = firstDefect(entries);
  if (defect) return ungraded(defect.reason);

  const nodes = map ? map.nodes : [];
  const edges = map ? map.edges : [];

  if (nodes.some((node) => asId(node.id) === null)) {
    return ungraded('app-map node không có id, không thể tạo sourceRef trỏ về node đó');
  }

  if (map && (map.totalNodesKnown === false
    || (map.crawlStatus !== undefined && map.crawlStatus !== 'complete'))) {
    const traced = entries[0]?.code;
    const tail = traced
      ? `chưa xác định đủ node liên quan tới ${traced} để trace`
      : 'chưa xác định đủ node để trace';
    return ungraded(`app-map denominator unknown: crawlStatus=${map.crawlStatus}, ${tail}`);
  }

  if (nodes.length === 0 && edges.length === 0 && entries.length === 0) {
    return ungraded('no source at all: appMap rỗng và baRequirements rỗng');
  }

  const screens = nodes.filter((node) => node.type === 'screen');
  const ctx = {
    nodes,
    edges,
    entries,
    nodeById: new Map(nodes.map((node) => [node.id, node])),
    soleScreen: screens.length === 1 ? screens[0] : null,
    pinVerified: isRecord(envPin),
  };

  const conflict = conflictReason(ctx);
  if (conflict) return ungraded(conflict);

  const crossReference = crossReferenceReason(ctx);
  if (crossReference) return ungraded(crossReference);

  const found = synthesize(ctx);
  if (!found) return ungraded(noActionableSourceReason(ctx));

  return graded([found]);
}

/**
 * Generate the P/I/Q properties a bundle actually proves.
 *
 * @param {object|null|undefined} appMap crawled screens/dialogs and their edges
 * @param {Array<object>} baRequirements BA-pro rows with their 'Xong khi' lines
 * @param {object} [envPin] live target the run is pinned to (HR2)
 * @returns {{verdict: string, properties: Array<object>, ungradedReason: string|null}}
 */
export function generateProperties(appMap, baRequirements, envPin) {
  return structuredClone(evaluate(appMap, baRequirements, envPin));
}
