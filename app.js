import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/* ===== Supabase (shared market + real accounts, same project as GDRandomLevel) ===== */
const SB_URL = 'https://cuwbpfchltyikamcothr.supabase.co';
const SB_KEY = 'sb_publishable_hXLNqzVaOVfDU5NA9aK6pQ__Br5dIVI';
const sb = createClient(SB_URL, SB_KEY);

let latestState = null;
let activeSymbol = null;
let startingCash = 10000;
let session = null;
let pollTimer = null;

const $ = (sel) => document.querySelector(sel);

function fmtMoney(n) {
  return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtShares(n) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- Auth screen plumbing ----------

function showAuthScreen() {
  $("#authOverlay").classList.add("open");
  $("#appLayout").classList.add("hidden");
}
function hideAuthScreen() {
  $("#authOverlay").classList.remove("open");
  $("#appLayout").classList.remove("hidden");
}

async function fetchState() {
  if (!session) return;
  const { data, error } = await sb.rpc('mf_get_state');
  if (error) {
    // session probably expired/invalid — send back to login
    console.error("mf_get_state failed:", error.message);
    showAuthScreen();
    return;
  }
  latestState = data;
  startingCash = data.starting_cash || startingCash;
  // stocks/portfolio come back as arrays from Postgres — index stocks by symbol for convenience
  latestState.stocksBySymbol = {};
  (latestState.stocks || []).forEach(s => { latestState.stocksBySymbol[s.symbol] = s; });
  hideAuthScreen();
  render();
}

function startPolling() {
  clearInterval(pollTimer);
  fetchState();
  pollTimer = setInterval(fetchState, 2000);
}

// ---------- Rendering ----------

function drawCandles(canvas, values) {
  // Each price-history point is a real trade, and an AMM swap moves price
  // monotonically in one direction — so open/close from consecutive points
  // gives an accurate candle with no synthetic high/low needed.
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.clearRect(0, 0, w, h);
  if (!values || values.length < 2) return;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const yFor = (v) => h - ((v - min) / range) * h * 0.85 - h * 0.075;

  const n = values.length - 1;
  // Cap how wide a slot can get — with only 1-2 trades so far, n is tiny and
  // w/n would stretch a single candle into a giant solid block filling the
  // whole card. Cap it to a sane width and center the group instead.
  const maxSlotW = 14 * devicePixelRatio;
  const slotW = Math.min(w / n, maxSlotW);
  const xOffset = (w - slotW * n) / 2;
  const bodyW = Math.max(1 * devicePixelRatio, slotW * 0.6);
  const minBodyH = 1.5 * devicePixelRatio;

  for (let i = 0; i < n; i++) {
    const open = values[i];
    const close = values[i + 1];
    const up = close >= open;
    const x = xOffset + i * slotW + slotW / 2;
    const yOpen = yFor(open);
    const yClose = yFor(close);
    const top = Math.min(yOpen, yClose);
    const bodyH = Math.max(minBodyH, Math.abs(yClose - yOpen));
    ctx.fillStyle = up ? "#16a34a" : "#dc2626";
    ctx.fillRect(x - bodyW / 2, top, bodyW, bodyH);
  }
}

function render() {
  if (!latestState) return;
  $("#accountName").textContent = latestState.username || "";
  $("#cashValue").textContent = fmtMoney(latestState.cash);
  $("#netWorthValue").textContent = fmtMoney(latestState.net_worth);
  const changePct = ((latestState.net_worth - startingCash) / startingCash) * 100;
  const sub = $("#netWorthChange");
  sub.textContent = (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "% all-time";
  sub.className = "stat-sub " + (changePct >= 0 ? "pos" : "neg");

  renderStockGrid();
  renderPortfolio();
  renderLeaderboard();
  renderActivity();

  if (activeSymbol && latestState.stocksBySymbol[activeSymbol]) {
    updateTradeModalPrice();
  }
}

function renderStockGrid() {
  const grid = $("#stockGrid");
  const stocks = [...(latestState.stocks || [])].sort((a, b) => a.symbol.localeCompare(b.symbol));
  grid.innerHTML = "";
  if (!stocks.length) {
    grid.innerHTML = '<div class="empty-note">No stocks listed yet — be the first to launch one!</div>';
    return;
  }
  stocks.forEach((s) => {
    const hist = s.history || [];
    const base = hist.length ? hist[0] : s.price;
    const changePct = base ? ((s.price - base) / base * 100) : 0;
    const pos = changePct >= 0;
    const card = document.createElement("div");
    card.className = "stock-card";
    card.innerHTML = `
      <div class="stock-card-top">
        <div>
          <div class="stock-symbol">${s.symbol} ${s.founder ? '<span class="founder-badge">★ yours</span>' : ""}</div>
          <div class="stock-name">${s.name}</div>
          <div class="stock-sector">${s.sector}</div>
        </div>
      </div>
      <div class="stock-price">${fmtMoney(s.price)}</div>
      <div class="stock-change ${pos ? "pos" : "neg"}">${pos ? "+" : ""}${changePct.toFixed(2)}%</div>
      <canvas class="sparkline"></canvas>
    `;
    card.addEventListener("click", () => openTradeModal(s.symbol));
    grid.appendChild(card);
    drawCandles(card.querySelector(".sparkline"), hist);
  });
}

function renderPortfolio() {
  const list = $("#portfolioList");
  const portfolio = latestState.portfolio || [];
  if (!portfolio.length) {
    list.innerHTML = '<div class="empty-note">You don\'t own anything yet.</div>';
    return;
  }
  list.innerHTML = "";
  portfolio.forEach((p) => {
    const row = document.createElement("div");
    row.className = "portfolio-row";
    row.innerHTML = `
      <div>
        <div class="portfolio-symbol">${p.symbol}</div>
        <div class="portfolio-meta">${fmtShares(p.shares)} sh @ ${fmtMoney(p.price)}</div>
      </div>
      <div class="portfolio-value">${fmtMoney(p.value)}</div>
    `;
    row.style.cursor = "pointer";
    row.addEventListener("click", () => openTradeModal(p.symbol));
    list.appendChild(row);
  });
}

function rankClass(i) {
  return i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : "";
}

function renderLeaderboard() {
  const lb = latestState.leaderboard || { richest: [], priciest: [] };

  const richestEl = $("#richestList");
  if (!lb.richest.length) {
    richestEl.innerHTML = '<div class="empty-note">No one has traded yet.</div>';
  } else {
    richestEl.innerHTML = "";
    lb.richest.forEach((r, i) => {
      const isYou = r.display_name === latestState.username;
      const row = document.createElement("div");
      row.className = `leaderboard-row ${rankClass(i)} ${isYou ? "is-you" : ""}`;
      row.innerHTML = `
        <div class="leaderboard-rank">${i + 1}</div>
        <div class="leaderboard-name">${r.display_name}${isYou ? " (you)" : ""}</div>
        <div class="leaderboard-value">${fmtMoney(r.net_worth)}</div>
      `;
      richestEl.appendChild(row);
    });
  }

  const priciestEl = $("#priciestList");
  if (!lb.priciest.length) {
    priciestEl.innerHTML = '<div class="empty-note">No stocks listed yet.</div>';
  } else {
    priciestEl.innerHTML = "";
    lb.priciest.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = `leaderboard-row ${rankClass(i)}`;
      row.innerHTML = `
        <div class="leaderboard-rank">${i + 1}</div>
        <div class="leaderboard-name">${s.symbol} · ${s.name}</div>
        <div class="leaderboard-value">${fmtMoney(s.price)}</div>
      `;
      row.style.cursor = "pointer";
      row.addEventListener("click", () => openTradeModal(s.symbol));
      priciestEl.appendChild(row);
    });
  }
}

function timeAgo(t) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - t));
  if (secs < 60) return secs + "s ago";
  if (secs < 3600) return Math.floor(secs / 60) + "m ago";
  return Math.floor(secs / 3600) + "h ago";
}

function renderActivity() {
  const feed = $("#activityFeed");
  const activity = latestState.activity || [];
  if (!activity.length) {
    feed.innerHTML = '<div class="empty-note">Nothing yet. Make a trade!</div>';
    return;
  }
  feed.innerHTML = "";
  activity.forEach((a) => {
    const item = document.createElement("div");
    item.className = "activity-item " + a.kind;
    item.innerHTML = `${a.text}<span class="a-time">${timeAgo(a.t)}</span>`;
    feed.appendChild(item);
  });
}

// ---------- Trade modal ----------

function openTradeModal(symbol) {
  activeSymbol = symbol;
  $("#tradeOverlay").classList.add("open");
  $("#tradeError").textContent = "";
  $("#buyAmount").value = "";
  $("#sellShares").value = "";
  $("#buyEstimate").textContent = "";
  $("#sellEstimate").textContent = "";
  setTradeTab("buy");
  updateTradeModalPrice();
}

function updateTradeModalPrice() {
  const s = latestState.stocksBySymbol[activeSymbol];
  if (!s) return;
  $("#tradeTitle").textContent = `${s.name} (${activeSymbol})`;
  $("#tradePrice").textContent = `Current price: ${fmtMoney(s.price)}`;
  const taxPct = latestState.trade_tax_pct ?? 0.25;
  $("#tradeTaxNote").textContent = `A ${taxPct}% trading tax applies to every buy/sell.`;
}

function setTradeTab(tab) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $("#buyPanel").classList.toggle("hidden", tab !== "buy");
  $("#sellPanel").classList.toggle("hidden", tab !== "sell");
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  if (t.dataset.tab) setTradeTab(t.dataset.tab);
}));

$("#buyAmount").addEventListener("input", () => {
  const amt = parseFloat($("#buyAmount").value);
  const s = latestState?.stocksBySymbol[activeSymbol];
  if (!s || !amt || amt <= 0) { $("#buyEstimate").textContent = ""; return; }
  $("#buyEstimate").textContent = `≈ ${(amt / s.price).toFixed(4)} shares (before price impact)`;
});
$("#sellShares").addEventListener("input", () => {
  const shares = parseFloat($("#sellShares").value);
  const s = latestState?.stocksBySymbol[activeSymbol];
  if (!s || !shares || shares <= 0) { $("#sellEstimate").textContent = ""; return; }
  $("#sellEstimate").textContent = `≈ ${fmtMoney(shares * s.price)} (before price impact)`;
});

$("#confirmBuy").addEventListener("click", async () => {
  const amount = parseFloat($("#buyAmount").value);
  if (!amount || amount <= 0) { $("#tradeError").textContent = "Enter a valid amount."; return; }
  const { error } = await sb.rpc('mf_buy', { p_symbol: activeSymbol, p_cash_amount: amount });
  if (error) { $("#tradeError").textContent = error.message || "Trade failed."; return; }
  await fetchState();
  toast(`Bought ${activeSymbol}`);
  $("#tradeOverlay").classList.remove("open");
});

$("#confirmSell").addEventListener("click", async () => {
  const shares = parseFloat($("#sellShares").value);
  if (!shares || shares <= 0) { $("#tradeError").textContent = "Enter a valid share amount."; return; }
  const { error } = await sb.rpc('mf_sell', { p_symbol: activeSymbol, p_shares_amount: shares });
  if (error) { $("#tradeError").textContent = error.message || "Trade failed."; return; }
  await fetchState();
  toast(`Sold ${activeSymbol}`);
  $("#tradeOverlay").classList.remove("open");
});

// ---------- Buy All modal ----------

$("#buyAllBtn").addEventListener("click", () => {
  const count = latestState?.stocks?.length || 0;
  if (!count) { toast("No stocks listed yet — launch one first!"); return; }
  $("#buyAllOverlay").classList.add("open");
  $("#buyAllError").textContent = "";
  $("#buyAllAmount").value = "";
  $("#buyAllEstimate").textContent = "";
  $("#buyAllCount").textContent = count;
  const taxPct = latestState.trade_tax_pct ?? 0.25;
  $("#buyAllTaxNote").textContent = `A ${taxPct}% trading tax applies to each of the ${count} buys.`;
});

$("#buyAllAmount").addEventListener("input", () => {
  const total = parseFloat($("#buyAllAmount").value);
  const count = latestState?.stocks?.length || 0;
  if (!total || total <= 0 || !count) { $("#buyAllEstimate").textContent = ""; return; }
  $("#buyAllEstimate").textContent = `≈ ${fmtMoney(total / count)} into each of ${count} stocks`;
});

$("#confirmBuyAll").addEventListener("click", async () => {
  const total = parseFloat($("#buyAllAmount").value);
  const symbols = (latestState?.stocks || []).map((s) => s.symbol);
  if (!total || total <= 0) { $("#buyAllError").textContent = "Enter a valid amount."; return; }
  if (!symbols.length) { $("#buyAllError").textContent = "No stocks to buy."; return; }
  if (total > latestState.cash + 1e-6) { $("#buyAllError").textContent = "You don't have that much cash."; return; }

  $("#confirmBuyAll").disabled = true;
  const perStock = total / symbols.length;
  let bought = 0, failed = 0;
  for (const symbol of symbols) {
    const { error } = await sb.rpc('mf_buy', { p_symbol: symbol, p_cash_amount: perStock });
    if (error) failed++; else bought++;
  }
  $("#confirmBuyAll").disabled = false;

  await fetchState();
  toast(failed
    ? `Bought into ${bought} stock${bought === 1 ? "" : "s"}, ${failed} failed`
    : `Bought into all ${bought} stock${bought === 1 ? "" : "s"}!`);
  $("#buyAllOverlay").classList.remove("open");
});

// ---------- Create stock modal ----------

$("#createStockBtn").addEventListener("click", () => {
  $("#createOverlay").classList.add("open");
  $("#createError").textContent = "";
  $("#newName").value = "";
  $("#newSymbol").value = "";
  $("#newSector").value = "";
  if (latestState) {
    $("#listingFeeText").textContent = fmtMoney(latestState.listing_fee);
    $("#founderBonusText").textContent = latestState.founder_bonus;
  }
});

$("#confirmCreate").addEventListener("click", async () => {
  const name = $("#newName").value.trim();
  const symbol = $("#newSymbol").value.trim().toUpperCase();
  const sector = $("#newSector").value.trim() || "Other";
  if (!name || !symbol) {
    $("#createError").textContent = "Fill in a company name and ticker symbol.";
    return;
  }
  const { error } = await sb.rpc('mf_create_stock', { p_name: name, p_symbol: symbol, p_sector: sector });
  if (error) { $("#createError").textContent = error.message || "Could not launch stock."; return; }
  await fetchState();
  toast(`${symbol} is now trading!`);
  $("#createOverlay").classList.remove("open");
});

// ---------- Modal close handling ----------

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.target.closest(".modal-overlay").classList.remove("open");
  });
});
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("open");
  });
});

// ---------- Auth screen ----------

document.querySelectorAll("[data-authtab]").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll("[data-authtab]").forEach((x) => x.classList.toggle("active", x === t));
    $("#loginPanel").classList.toggle("hidden", t.dataset.authtab !== "login");
    $("#signupPanel").classList.toggle("hidden", t.dataset.authtab !== "signup");
    $("#authError").textContent = "";
  });
});

$("#confirmLogin").addEventListener("click", async () => {
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  if (!email || !password) { $("#authError").textContent = "Enter your email and password."; return; }
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { $("#authError").textContent = error.message || "Login failed."; return; }
});

$("#confirmSignup").addEventListener("click", async () => {
  const email = $("#signupEmail").value.trim();
  const password = $("#signupPassword").value;
  if (!email || !password) { $("#authError").textContent = "Enter an email and password."; return; }
  if (password.length < 6) { $("#authError").textContent = "Password must be at least 6 characters."; return; }
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) { $("#authError").textContent = error.message || "Sign up failed."; return; }
  if (!data.session) {
    $("#authError").textContent = "";
    toast("Account created — check your email to confirm it, then log in.");
  }
});

["#loginEmail", "#loginPassword", "#signupEmail", "#signupPassword"].forEach((sel) => {
  $(sel).addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const isLogin = sel.startsWith("#login");
    $(isLogin ? "#confirmLogin" : "#confirmSignup").click();
  });
});

$("#logoutBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
});

$("#googleSignInBtn").addEventListener("click", async () => {
  $("#authError").textContent = "";
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) $("#authError").textContent = error.message || "Google sign-in failed.";
});

// ---------- Auth state ----------

sb.auth.onAuthStateChange((_event, s) => {
  session = s;
  setTimeout(() => {
    if (session) {
      startPolling();
    } else {
      clearInterval(pollTimer);
      latestState = null;
      showAuthScreen();
    }
  }, 0);
});

showAuthScreen(); // instant UI; the auth listener above takes over once the session resolves
