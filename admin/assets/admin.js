(function(){
  "use strict";

  const loginScreen = document.getElementById("login-screen");
  const dashboard = document.getElementById("dashboard");
  const pwInput = document.getElementById("pw-input");
  const loginBtn = document.getElementById("login-btn");
  const loginError = document.getElementById("login-error");
  const logoutBtn = document.getElementById("logout-btn");
  const syncBtn = document.getElementById("sync-btn");
  const syncStatus = document.getElementById("sync-status");
  const bizName = document.getElementById("biz-name");
  const bizEmail = document.getElementById("biz-email");
  const hoursPerDay = document.getElementById("hours-per-day");
  const bufferDays = document.getElementById("buffer-days");
  const saveSettingsBtn = document.getElementById("save-settings-btn");
  const settingsStatus = document.getElementById("settings-status");
  const smtpStatusLine = document.getElementById("smtp-status-line");
  const smtpTestBtn = document.getElementById("smtp-test-btn");
  const smtpTestStatus = document.getElementById("smtp-test-status");
  const squareStatusLine = document.getElementById("square-status-line");
  const squarePushAllBtn = document.getElementById("square-push-all-btn");
  const squarePushAllStatus = document.getElementById("square-push-all-status");
  const squareFailuresWrap = document.getElementById("square-failures-wrap");
  const squareFailuresHeading = document.getElementById("square-failures-heading");
  const squareFailureRowsEl = document.getElementById("square-failure-rows");
  const eventModeToggle = document.getElementById("event-mode-toggle");
  const kioskModeToggle = document.getElementById("kiosk-mode-toggle");
  const kioskIdleMinutes = document.getElementById("kiosk-idle-minutes");
  const saveEventSettingsBtn = document.getElementById("save-event-settings-btn");
  const eventSettingsStatus = document.getElementById("event-settings-status");
  const quotesEmpty = document.getElementById("quotes-empty");
  const quotesTable = document.getElementById("quotes-table");
  const quoteRowsEl = document.getElementById("quote-rows");
  const rowsEl = document.getElementById("design-rows");
  const searchEl = document.getElementById("admin-search");
  const selectAllCheckbox = document.getElementById("select-all-checkbox");
  const selectedCountEl = document.getElementById("selected-count");
  const pushSelectedBtn = document.getElementById("push-selected-btn");
  const qrCodeImg = document.getElementById("qr-code-img");
  const qrUrlEl = document.getElementById("qr-url");
  const qrCopyBtn = document.getElementById("qr-copy-btn");
  const qrPrintBtn = document.getElementById("qr-print-btn");
  const qrStatus = document.getElementById("qr-status");
  const errorLogEmpty = document.getElementById("error-log-empty");
  const errorLogTable = document.getElementById("error-log-table");
  const errorLogRowsEl = document.getElementById("error-log-rows");
  const errorLogClearBtn = document.getElementById("error-log-clear-btn");

  let allDesigns = [];
  const selectedSlugs = new Set();

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  async function checkSession(){
    const r = await fetch("/api/admin/session").then(r => r.json());
    if(r.isAdmin) showDashboard(); else showLogin();
  }

  // ---- session-expiry handling ----
  // Sessions are in-memory server-side, so a server restart (redeploy etc.)
  // invalidates every existing session at once — the dashboard stays open
  // client-side (nothing told it to log out) until the next API call 401s.
  // Without this, that shows up as a confusing "Sync failed: not_authenticated"
  // or a broken QR code image instead of the real explanation.
  let sessionExpired = false;
  async function adminFetch(url, opts){
    const res = await fetch(url, opts);
    if(res.status === 401 && !sessionExpired){
      let body = null;
      try{ body = await res.clone().json(); }catch(e){}
      if(body && body.error === "not_authenticated"){
        sessionExpired = true;
        showLogin();
        loginError.textContent = "Your session expired — please log in again.";
      }
    }
    return res;
  }

  function showLogin(){
    loginScreen.style.display = "flex";
    dashboard.style.display = "none";
  }
  async function showDashboard(){
    loginScreen.style.display = "none";
    dashboard.style.display = "block";
    await loadSquareStatus();
    await Promise.all([loadSettings(), loadDesigns(), loadSmtpStatus(), loadQuotes(), loadQrCode(), loadErrorLogs()]);
  }

  // ---- storefront QR code ----
  async function loadQrCode(){
    qrCodeImg.src = "/api/admin/qrcode.png?t=" + Date.now(); // bust the cache if the host changes between visits
    try{
      const r = await adminFetch("/api/admin/qrcode-url").then(r => r.json());
      qrUrlEl.textContent = r.url;
    }catch(err){
      qrUrlEl.textContent = "";
    }
  }
  qrCopyBtn.addEventListener("click", async () => {
    try{
      await navigator.clipboard.writeText(qrUrlEl.textContent);
      qrStatus.textContent = "Copied";
      setTimeout(() => qrStatus.textContent = "", 1500);
    }catch(err){
      qrStatus.textContent = "Couldn't copy — copy it manually.";
    }
  });
  qrPrintBtn.addEventListener("click", () => window.print());

  loginBtn.addEventListener("click", doLogin);
  pwInput.addEventListener("keydown", e => { if(e.key === "Enter") doLogin(); });

  async function doLogin(){
    loginError.textContent = "";
    loginBtn.disabled = true;
    try{
      const res = await fetch("/api/admin/login", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ password: pwInput.value })
      });
      if(!res.ok){
        loginError.textContent = res.status === 429
          ? "Too many attempts — please wait a bit and try again."
          : "Wrong password.";
        loginBtn.disabled = false;
        return;
      }
      pwInput.value = "";
      sessionExpired = false;
      await showDashboard();
    }catch(err){
      loginError.textContent = "Couldn't reach the server.";
    }finally{
      loginBtn.disabled = false;
    }
  }

  logoutBtn.addEventListener("click", async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    showLogin();
  });

  // ---- settings ----
  async function loadSettings(){
    const s = await adminFetch("/api/admin/settings").then(r => r.json());
    bizName.value = s.businessName || "";
    bizEmail.value = s.businessEmail || "";
    hoursPerDay.value = s.hoursPerDayCapacity != null ? s.hoursPerDayCapacity : 6;
    bufferDays.value = s.leadTimeBufferDays != null ? s.leadTimeBufferDays : 2;
    eventModeToggle.checked = !!s.eventModeEnabled;
    kioskModeToggle.checked = !!s.kioskModeEnabled;
    kioskIdleMinutes.value = s.kioskIdleMinutes != null ? s.kioskIdleMinutes : 2;
  }
  saveSettingsBtn.addEventListener("click", async () => {
    settingsStatus.textContent = "Saving…";
    try{
      const res = await adminFetch("/api/admin/settings", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          businessName: bizName.value,
          businessEmail: bizEmail.value,
          hoursPerDayCapacity: hoursPerDay.value,
          leadTimeBufferDays: bufferDays.value
        })
      });
      if(!res.ok) throw new Error();
      settingsStatus.textContent = "Saved.";
      setTimeout(() => settingsStatus.textContent = "", 2000);
    }catch(err){
      settingsStatus.textContent = "Failed to save — check the lead time fields are valid numbers.";
    }
  });

  saveEventSettingsBtn.addEventListener("click", async () => {
    eventSettingsStatus.textContent = "Saving…";
    try{
      const res = await adminFetch("/api/admin/settings", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          eventModeEnabled: eventModeToggle.checked,
          kioskModeEnabled: kioskModeToggle.checked,
          kioskIdleMinutes: kioskIdleMinutes.value
        })
      });
      if(!res.ok) throw new Error();
      eventSettingsStatus.textContent = "Saved.";
      setTimeout(() => eventSettingsStatus.textContent = "", 2000);
      loadDesigns(); // visible/featured filtering may have changed what matters to show
    }catch(err){
      eventSettingsStatus.textContent = "Failed to save — check idle minutes is a valid number.";
    }
  });

  // ---- SMTP status ----
  async function loadSmtpStatus(){
    try{
      const r = await adminFetch("/api/admin/smtp-status").then(r => r.json());
      smtpStatusLine.textContent = r.configured
        ? "SMTP is configured — customers can receive PDF quotes by email."
        : "SMTP is not configured — the storefront will fall back to a plain mailto link instead of emailing PDFs. Set SMTP_HOST / SMTP_USER / SMTP_PASS etc. in the environment.";
    }catch(err){
      smtpStatusLine.textContent = "Couldn't check SMTP status.";
    }
  }
  smtpTestBtn.addEventListener("click", async () => {
    smtpTestBtn.disabled = true;
    smtpTestStatus.textContent = "Testing…";
    try{
      const res = await adminFetch("/api/admin/smtp-test", { method: "POST" });
      const j = await res.json();
      smtpTestStatus.textContent = res.ok ? "Connected OK." : ("Failed: " + j.error);
    }catch(err){
      smtpTestStatus.textContent = "Failed: couldn't reach server.";
    }finally{
      smtpTestBtn.disabled = false;
    }
  });

  // ---- Square catalog push ----
  let squareConfigured = false;
  async function loadSquareStatus(){
    try{
      const r = await adminFetch("/api/admin/square-status").then(r => r.json());
      squareConfigured = !!r.configured;
      squareStatusLine.textContent = squareConfigured
        ? "Square is configured — designs can be pushed to your Square catalog."
        : "Square is not configured — set SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID in the environment to enable this.";
      squarePushAllBtn.disabled = !squareConfigured;
    }catch(err){
      squareStatusLine.textContent = "Couldn't check Square status.";
    }
  }
  squarePushAllBtn.addEventListener("click", async () => {
    squarePushAllBtn.disabled = true;
    squarePushAllStatus.textContent = "Pushing to Square — this can take a moment…";
    try{
      const res = await adminFetch("/api/admin/square-push-all", {
        method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({})
      });
      const j = await res.json();
      if(!res.ok) throw new Error(j.error || "push failed");
      squarePushAllStatus.textContent = "Done — " + j.pushed + " pushed" + (j.failed ? ", " + j.failed + " failed" : "") + ".";
      await loadDesigns();
    }catch(err){
      squarePushAllStatus.textContent = "Failed: " + err.message;
    }finally{
      squarePushAllBtn.disabled = !squareConfigured;
    }
  });

  // ---- designs ----
  async function loadDesigns(){
    const r = await adminFetch("/api/admin/designs").then(r => r.json());
    allDesigns = r.data || [];
    renderRows();
    renderSquareFailures();
  }

  function renderSquareFailures(){
    const failed = allDesigns.filter(d => d.square_sync_error);
    if(!failed.length){
      squareFailuresWrap.style.display = "none";
      return;
    }
    failed.sort((a, b) => (b.square_sync_error_at || "").localeCompare(a.square_sync_error_at || ""));
    squareFailuresWrap.style.display = "block";
    squareFailuresHeading.textContent = failed.length + " design" + (failed.length === 1 ? "" : "s") + " failed to sync to Square:";
    squareFailureRowsEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    for(const d of failed) frag.appendChild(buildSquareFailureRow(d));
    squareFailureRowsEl.appendChild(frag);
  }

  function buildSquareFailureRow(d){
    const tr = document.createElement("tr");
    const when = d.square_sync_error_at ? new Date(d.square_sync_error_at) : null;
    const whenStr = when && !isNaN(when) ? when.toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }) : "—";

    const tdTitle = document.createElement("td");
    tdTitle.textContent = d.title;
    tr.appendChild(tdTitle);

    const tdErr = document.createElement("td");
    tdErr.style.color = "var(--red)";
    tdErr.textContent = d.square_sync_error;
    tr.appendChild(tdErr);

    const tdWhen = document.createElement("td");
    tdWhen.textContent = whenStr;
    tr.appendChild(tdWhen);

    const tdRetry = document.createElement("td");
    const retryBtn = document.createElement("button");
    retryBtn.className = "btn small";
    retryBtn.textContent = "Retry";
    retryBtn.disabled = !squareConfigured;
    retryBtn.addEventListener("click", async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying…";
      try{
        const res = await adminFetch("/api/admin/designs/" + encodeURIComponent(d.slug) + "/square-push", { method: "POST" });
        const j = await res.json();
        if(!res.ok) throw new Error(j.error || "push failed");
        await loadDesigns();
      }catch(err){
        retryBtn.disabled = !squareConfigured;
        retryBtn.textContent = "Retry";
        await loadDesigns(); // refresh so the (still-failing) error message / timestamp is current
      }
    });
    tdRetry.appendChild(retryBtn);
    tr.appendChild(tdRetry);

    return tr;
  }

  searchEl.addEventListener("input", renderRows);

  let currentList = [];

  function renderRows(){
    const q = searchEl.value.trim().toLowerCase();
    currentList = q ? allDesigns.filter(d => (d.title||"").toLowerCase().includes(q) || d.slug.includes(q)) : allDesigns;
    // drop selections for designs no longer in view (deleted/renamed) — keeps the set tidy
    for(const slug of Array.from(selectedSlugs)){
      if(!allDesigns.some(d => d.slug === slug)) selectedSlugs.delete(slug);
    }
    rowsEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    for(const d of currentList) frag.appendChild(buildRow(d));
    rowsEl.appendChild(frag);
    updateSelectionUi();
  }

  function updateSelectionUi(){
    selectedCountEl.textContent = selectedSlugs.size + " selected";
    pushSelectedBtn.disabled = selectedSlugs.size === 0 || !squareConfigured;
    const visibleSelected = currentList.filter(d => selectedSlugs.has(d.slug)).length;
    selectAllCheckbox.checked = currentList.length > 0 && visibleSelected === currentList.length;
    selectAllCheckbox.indeterminate = visibleSelected > 0 && visibleSelected < currentList.length;
  }

  selectAllCheckbox.addEventListener("change", () => {
    for(const d of currentList){
      if(selectAllCheckbox.checked) selectedSlugs.add(d.slug);
      else selectedSlugs.delete(d.slug);
    }
    renderRows();
  });

  pushSelectedBtn.addEventListener("click", async () => {
    const slugs = Array.from(selectedSlugs);
    if(!slugs.length) return;
    pushSelectedBtn.disabled = true;
    selectedCountEl.textContent = "Pushing " + slugs.length + " to Square…";
    try{
      const res = await adminFetch("/api/admin/square-push-all", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ slugs })
      });
      const j = await res.json();
      if(!res.ok) throw new Error(j.error || "push failed");
      selectedSlugs.clear();
      await loadDesigns();
      selectedCountEl.textContent = "Done — " + j.pushed + " pushed" + (j.failed ? ", " + j.failed + " failed" : "") + ".";
      setTimeout(updateSelectionUi, 3000);
    }catch(err){
      selectedCountEl.textContent = "Failed: " + err.message;
    }finally{
      pushSelectedBtn.disabled = selectedSlugs.size === 0 || !squareConfigured;
    }
  });

  function setSquareRowStatus(el, d){
    const failedAfterSync = d.square_sync_error &&
      (!d.square_synced_at || (d.square_sync_error_at || "") > d.square_synced_at);
    if(failedAfterSync){
      el.textContent = "Failed: " + d.square_sync_error;
      el.style.color = "var(--red)";
    } else {
      el.textContent = d.square_synced_at ? "Synced" : "";
      el.style.color = "";
    }
  }

  function buildRow(d){
    const tr = document.createElement("tr");
    if(d.visible === false) tr.classList.add("hidden-row");

    const tdCheck = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedSlugs.has(d.slug);
    checkbox.addEventListener("change", () => {
      if(checkbox.checked) selectedSlugs.add(d.slug);
      else selectedSlugs.delete(d.slug);
      updateSelectionUi();
    });
    tdCheck.appendChild(checkbox);
    tr.appendChild(tdCheck);

    const tdThumb = document.createElement("td");
    const img = document.createElement("img");
    img.className = "thumb"; img.src = d.image_url || ""; img.loading = "lazy";
    tdThumb.appendChild(img);
    tr.appendChild(tdThumb);

    const tdTitle = document.createElement("td");
    tdTitle.innerHTML = '<div class="t">' + escapeHtml(d.title) +
      '</div><div style="color:var(--text-faint);font-size:0.72rem;">' +
      escapeHtml(d.category || "") + (d.round != null ? " · round " + escapeHtml(String(d.round)) : "") +
      (d.purchase_only ? " · extra" : "") + '</div>';
    tr.appendChild(tdTitle);

    const tdPrice = document.createElement("td");
    const priceInput = document.createElement("input");
    priceInput.type = "number"; priceInput.min = "0"; priceInput.step = "0.01"; priceInput.className = "price";
    priceInput.placeholder = "—";
    priceInput.value = d.price_cents != null ? (d.price_cents / 100).toFixed(2) : "";
    tdPrice.appendChild(priceInput);
    tr.appendChild(tdPrice);

    const tdUrl = document.createElement("td");
    const urlInput = document.createElement("input");
    urlInput.type = "text"; urlInput.placeholder = "https://yourshop.com/…";
    urlInput.value = d.shop_url || "";
    tdUrl.appendChild(urlInput);
    tr.appendChild(tdUrl);

    const tdVisible = document.createElement("td");
    const visCheck = document.createElement("input");
    visCheck.type = "checkbox"; visCheck.checked = d.visible !== false;
    tdVisible.appendChild(visCheck);
    tr.appendChild(tdVisible);

    const tdFeatured = document.createElement("td");
    const featCheck = document.createElement("input");
    featCheck.type = "checkbox"; featCheck.checked = !!d.featured;
    tdFeatured.appendChild(featCheck);
    tr.appendChild(tdFeatured);

    const tdSquare = document.createElement("td");
    const squareBtn = document.createElement("button");
    squareBtn.className = "btn small";
    squareBtn.textContent = d.square_item_id ? "Update" : "Push";
    squareBtn.disabled = !squareConfigured;
    const squareStatus = document.createElement("div");
    squareStatus.className = "row-status";
    squareStatus.style.display = "block";
    setSquareRowStatus(squareStatus, d);
    squareBtn.addEventListener("click", async () => {
      squareBtn.disabled = true;
      squareStatus.textContent = "Pushing…";
      squareStatus.style.color = "";
      try{
        const res = await adminFetch("/api/admin/designs/" + encodeURIComponent(d.slug) + "/square-push", { method: "POST" });
        const j = await res.json();
        if(!res.ok) throw new Error(j.error || "push failed");
        Object.assign(d, j.data);
        d.square_sync_error = null;
        squareBtn.textContent = "Update";
        setSquareRowStatus(squareStatus, d);
        renderSquareFailures();
      }catch(err){
        d.square_sync_error = err.message;
        d.square_sync_error_at = new Date().toISOString();
        setSquareRowStatus(squareStatus, d);
        renderSquareFailures();
      }finally{
        squareBtn.disabled = !squareConfigured;
      }
    });
    tdSquare.appendChild(squareBtn);
    tdSquare.appendChild(squareStatus);
    tr.appendChild(tdSquare);

    const tdSave = document.createElement("td");
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn small row-save"; saveBtn.textContent = "Save";
    const status = document.createElement("span");
    status.className = "row-status";
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      status.textContent = "Saving…";
      try{
        const res = await adminFetch("/api/admin/designs/" + encodeURIComponent(d.slug), {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({
            price: priceInput.value === "" ? "" : priceInput.value,
            shop_url: urlInput.value.trim(),
            visible: visCheck.checked,
            featured: featCheck.checked
          })
        });
        if(!res.ok) throw new Error();
        const saved = (await res.json()).data;
        Object.assign(d, saved);
        tr.classList.toggle("hidden-row", d.visible === false);
        status.textContent = "Saved";
        setTimeout(() => status.textContent = "", 1500);
      }catch(err){
        status.textContent = "Failed";
      }finally{
        saveBtn.disabled = false;
      }
    });
    tdSave.appendChild(saveBtn);
    tdSave.appendChild(status);
    tr.appendChild(tdSave);

    return tr;
  }

  // ---- quote request log ----
  async function loadQuotes(){
    try{
      const r = await adminFetch("/api/admin/quotes").then(r => r.json());
      const rows = r.data || [];
      quotesEmpty.style.display = rows.length ? "none" : "block";
      quotesTable.style.display = rows.length ? "table" : "none";
      quoteRowsEl.innerHTML = "";
      const frag = document.createDocumentFragment();
      for(const q of rows) frag.appendChild(buildQuoteRow(q));
      quoteRowsEl.appendChild(frag);
    }catch(err){
      quotesEmpty.style.display = "block";
      quotesEmpty.textContent = "Couldn't load quote requests.";
    }
  }

  function buildQuoteRow(q){
    const tr = document.createElement("tr");
    const date = new Date(q.createdAt);
    const dateStr = isNaN(date) ? q.createdAt : date.toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
    const itemTitles = (q.items || []).map(i => i.title).join(", ");
    const cost = q.totalCents != null ? "$" + (q.totalCents/100).toFixed(2) : "—";
    const lead = q.leadTimeLow != null ? q.leadTimeLow + "–" + q.leadTimeHigh + "d" : "—";
    const statusColor = q.status === "sent" ? "var(--teal)" : "var(--red)";

    tr.innerHTML =
      '<td>' + escapeHtml(dateStr) + '</td>' +
      '<td>' + escapeHtml(q.customerName || "—") + '<div style="color:var(--text-faint);font-size:0.72rem;">' + escapeHtml(q.customerEmail || "") + '</div></td>' +
      '<td style="max-width:220px;">' + escapeHtml(itemTitles) + '</td>' +
      '<td>' + escapeHtml(cost) + '</td>' +
      '<td>' + escapeHtml(lead) + '</td>' +
      '<td style="color:' + statusColor + ';">' + escapeHtml(q.status || "") + '</td>';
    return tr;
  }

  // ---- error log ----
  async function loadErrorLogs(){
    try{
      const r = await adminFetch("/api/admin/error-logs").then(r => r.json());
      const rows = r.data || [];
      errorLogEmpty.style.display = rows.length ? "none" : "block";
      errorLogTable.style.display = rows.length ? "table" : "none";
      errorLogRowsEl.innerHTML = "";
      const frag = document.createDocumentFragment();
      for(const e of rows) frag.appendChild(buildErrorLogRow(e));
      errorLogRowsEl.appendChild(frag);
    }catch(err){
      errorLogEmpty.style.display = "block";
      errorLogEmpty.textContent = "Couldn't load the error log.";
    }
  }

  function buildErrorLogRow(e){
    const tr = document.createElement("tr");
    const date = new Date(e.createdAt);
    const dateStr = isNaN(date) ? e.createdAt : date.toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit", second:"2-digit" });
    const message = e.detail ? e.message + " — " + e.detail : e.message;
    tr.innerHTML =
      '<td>' + escapeHtml(dateStr) + '</td>' +
      '<td><span style="font-family:var(--mono);font-size:0.72rem;color:var(--text-faint);">' + escapeHtml(e.type || "") + '</span></td>' +
      '<td style="color:var(--red);">' + escapeHtml(message || "") + '</td>' +
      '<td style="color:var(--text-faint);font-size:0.76rem;">' + escapeHtml(e.path || "") + '</td>';
    return tr;
  }

  errorLogClearBtn.addEventListener("click", async () => {
    errorLogClearBtn.disabled = true;
    try{
      await adminFetch("/api/admin/error-logs/clear", { method: "POST" });
      await loadErrorLogs();
    }finally{
      errorLogClearBtn.disabled = false;
    }
  });

  // ---- sync ----
  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    syncStatus.textContent = "Syncing from N3D — this can take a moment…";
    try{
      const res = await adminFetch("/api/admin/sync", {
        method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ full: false })
      });
      const j = await res.json();
      if(!res.ok) throw new Error(j.error || "sync failed");
      syncStatus.textContent = "Done — " + j.added + " new, " + j.updated + " updated" +
        (j.spritesFilled ? ", " + j.spritesFilled + " sprite" + (j.spritesFilled === 1 ? "" : "s") + " filled in" : "") + ".";
      await loadDesigns();
    }catch(err){
      syncStatus.textContent = "Sync failed: " + err.message;
    }finally{
      syncBtn.disabled = false;
    }
  });

  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("/admin/sw.js").catch(() => {});
  }

  checkSession();
})();
