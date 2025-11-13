import React, { useEffect, useState } from "react";

/* Types */
type Lead = { from: string; name?: string; text?: string; ts?: number; bot?: string; };
type PricingRow = { brand?: string; model?: string; exshowroom?: string; onroad?: string; region?: string; };
type UsedCar = { id: string; make: string; model: string; year: number; price: string; };
type FinanceRow = { id?: string; lead?: string; amount?: string; bank?: string; status?: string; };

/* Utility: naive parser for new-car queries */
function parseNewCarRequest(text = "") {
  // Make uppercase for consistent parsing
  const s = (text || "").toUpperCase();
  // Models we expect (expandable)
  const models = ["FORTUNER", "HYCROSS", "CAMRY", "HYRIDER", "LEGENDER", "INNOVA", "COROLLA", "GLANZA"];
  const suffixes = ["ZXO", "ZX (O)", "4X2 AUTO", "4X4 AUTO", "ZX"];
  const regions = ["DELHI", "HARYANA", "RAJASTHAN", "PUNJAB", "UP", "UTTAR PRADESH", "MAHARASHTRA"];
  let model = models.find(m => s.includes(m)) || "";
  let suffix = suffixes.find(x => s.includes(x)) || "";
  let region = regions.find(r => s.includes(r)) || "";
  // sometimes user writes city: "Delhi" or "delhi company" -> still match DELHI
  return { model, suffix, region, raw: text || "" };
}

/* Helper to find best pricing match */
function findPricingMatch(pricing: PricingRow[], model: string, region: string) {
  if (!model) return null;
  const m = model.toUpperCase();
  // Prefer exact model match and same region (if region present)
  const candidates = pricing.filter(p => (p.model || "").toUpperCase().includes(m));
  if (region) {
    const reg = region.toUpperCase();
    const regMatches = candidates.filter(p => (p.region || "").toUpperCase().includes(reg) || (p.onroad || "").toUpperCase().includes(reg));
    if (regMatches.length) return regMatches[0];
  }
  return candidates[0] || null;
}

/* Main component */
export default function App(): JSX.Element {
  const [tab, setTab] = useState<"new" | "used" | "finance" | "sell">("new");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [pricing, setPricing] = useState<PricingRow[]>([]);
  const [usedCars, setUsedCars] = useState<UsedCar[]>([]);
  const [financeRows, setFinanceRows] = useState<FinanceRow[]>([]);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [selectedBot, setSelectedBot] = useState<string>("");
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [replyText, setReplyText] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [leadsRes, pricingRes, usedRes, financeRes, botsRes] = await Promise.all([
        fetch("/leads").then(r => r.ok ? r.json() : []).catch(()=>[]),
        fetch("/pricing").then(r => r.ok ? r.json() : []).catch(()=>[]),
        fetch("/usedcars").then(r => r.ok ? r.json() : []).catch(()=>[]),
        fetch("/finance").then(r => r.ok ? r.json() : []).catch(()=>[]),
        fetch("/bots").then(r => r.ok ? r.json() : []).catch(()=>[]),
      ]);
      setLeads(Array.isArray(leadsRes) ? leadsRes : []);
      setPricing(Array.isArray(pricingRes) ? pricingRes : []);
      setUsedCars(Array.isArray(usedRes) ? usedRes : []);
      setFinanceRows(Array.isArray(financeRes) ? financeRes : []);
      setBots(Array.isArray(botsRes) ? botsRes : []);
      if (Array.isArray(botsRes) && botsRes[0]) setSelectedBot(botsRes[0].id);
    } catch (e) {
      console.warn("loadAll error", e);
    } finally {
      setLoading(false);
    }
  }

  async function sendReply(lead: Lead) {
    if (!replyText.trim()) return alert("Type a reply first.");
    setLoading(true);
    try {
      await fetch("/send", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ bot: selectedBot, to: lead.from, message: replyText.trim() }) });
      setReplyText("");
      alert("Reply attempted (check logs).");
      loadAll();
    } catch (e) {
      alert("Send error");
      console.warn(e);
    } finally { setLoading(false); }
  }

  async function markCalled(lead: Lead) {
    try {
      await fetch("/leads/mark-called", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ from: lead.from }) });
      alert("Marked called");
      loadAll();
    } catch (e) { console.warn(e); }
  }
  async function archiveLead(lead: Lead) {
    try {
      await fetch("/leads/archive", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ from: lead.from }) });
      alert("Archived");
      loadAll();
    } catch (e) { console.warn(e); }
  }

  const headerStyle: React.CSSProperties = { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"18px 28px", background: "linear-gradient(90deg,#071133,#0f172a)", color:"white", boxShadow:"0 10px 30px rgba(2,6,23,0.35)" };
  const containerStyle: React.CSSProperties = { display:"grid", gridTemplateColumns:"340px 1fr", gap:24, maxWidth:1300, margin:"26px auto", padding:"0 18px" };
  const panelStyle: React.CSSProperties = { background:"#ffffff", borderRadius:12, boxShadow:"0 8px 24px rgba(2,6,23,0.06)", overflow:"hidden", border:"1px solid rgba(2,6,23,0.04)" };
  const smallMuted: React.CSSProperties = { color:"#6b7280", fontSize:13 };

  return (
    <div style={{ fontFamily: "Inter, system-ui, -apple-system", background: "linear-gradient(180deg,#f7f8fb,#fff)", minHeight: "100vh" }}>
      <div style={headerStyle}>
        <div style={{ display:"flex", gap:12, alignItems:"center" }}>
          <div style={{ width:56, height:56, borderRadius:12, background:"linear-gradient(135deg,#ffd369,#ff7ab6)", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, color:"#081029", boxShadow:"0 8px 26px rgba(255,122,182,0.12)" }}>MC</div>
          <div>
            <div style={{ fontSize:18, fontWeight:800 }}>Mr.Car • Signature CRM</div>
            <div style={{ fontSize:12, color:"rgba(255,255,255,0.85)" }}>New Car · Used Car · Finance · Sell (Exchange as Sell)</div>
          </div>
        </div>

        <div style={{ display:"flex", gap:12, alignItems:"center" }}>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:12, color:"rgba(255,255,255,0.8)" }}>Active Bot</div>
            <select value={selectedBot} onChange={e=>setSelectedBot(e.target.value)} style={{ marginTop:6, padding:"8px 10px", borderRadius:8 }}>
              {bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <button onClick={loadAll} style={{ background:"linear-gradient(90deg,#4f46e5,#06b6d4)", color:"white", padding:"10px 14px", borderRadius:10, border:"none", cursor:"pointer" }}>Refresh</button>
        </div>
      </div>

      <div style={containerStyle}>
        {/* Left column - leads list */}
        <div style={{ ...panelStyle, display:"flex", flexDirection:"column", minHeight:560 }}>
          <div style={{ padding:16, borderBottom:"1px solid rgba(2,6,23,0.04)", fontWeight:700 }}>Leads</div>

          {/* tabs filter: new / used / finance / sell */}
          <div style={{ display:"flex", gap:8, padding:"12px 16px", borderBottom:"1px solid rgba(2,6,23,0.02)" }}>
            <button onClick={()=>setTab("new")} style={{ padding:"8px 12px", borderRadius:8, background: tab==="new" ? "linear-gradient(90deg,#eef2ff,#eefefc)" : "transparent", border:"1px solid rgba(2,6,23,0.04)" }}>New Car</button>
            <button onClick={()=>setTab("used")} style={{ padding:"8px 12px", borderRadius:8, background: tab==="used" ? "linear-gradient(90deg,#eef2ff,#eefefc)" : "transparent", border:"1px solid rgba(2,6,23,0.04)" }}>Used Car</button>
            <button onClick={()=>setTab("finance")} style={{ padding:"8px 12px", borderRadius:8, background: tab==="finance" ? "linear-gradient(90deg,#eef2ff,#eefefc)" : "transparent", border:"1px solid rgba(2,6,23,0.04)" }}>Finance</button>
            <button onClick={()=>setTab("sell")} style={{ padding:"8px 12px", borderRadius:8, background: tab==="sell" ? "linear-gradient(90deg,#eef2ff,#eefefc)" : "transparent", border:"1px solid rgba(2,6,23,0.04)" }}>Sell</button>
          </div>

          <div style={{ overflowY:"auto", flex:1 }}>
            {leads.length === 0 && <div style={{ padding:20, ...smallMuted }}>No leads yet — send a message to your bot to generate sample leads.</div>}

            {/* Filter leads by current tab: naive classification based on text */}
            {leads.filter(l => {
              const t = (l.text||"").toUpperCase();
              if (tab === "new") return /\b(HYCROSS|FORTUNER|CAMRY|HYRIDER|LEGENDER|COROLLA|INNOVA|GLANZA)\b/.test(t);
              if (tab === "used") return /\b(SELL|EXCHANGE|PRE-OWNED|USED|SECOND HAND)\b/.test(t) || /\b(SELL MY|SELL-MY|SELLMY)\b/.test(t);
              if (tab === "finance") return /\b(LOAN|FINANCE|EMI|BANK|DOCUMENTS|APPLY)\b/.test(t);
              if (tab === "sell") return /\b(SELL|EXCHANGE|BUYBACK|SELL MY|SELL-MY)\b/.test(t);
              return true;
            }).map((l) => (
              <div key={l.from} onClick={() => { setSelectedLead(l); setReplyText("") }} style={{ display:"flex", gap:12, padding:14, borderBottom:"1px solid rgba(2,6,23,0.03)", cursor:"pointer", alignItems:"center" }}>
                <div style={{ width:52, height:52, borderRadius:10, background:"linear-gradient(135deg,#ffd369,#ff7ab6)", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800 }}>{(l.name || l.from).toString().charAt(0).toUpperCase()}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:700 }}>{l.name || l.from}</div>
                  <div style={{ fontSize:13, color:"#475569", marginTop:4 }}>{(l.text || "— no message —").slice(0,120)}</div>
                  <div style={{ marginTop:8, fontSize:12, color:"#94a3b8" }}>{new Date(l.ts || Date.now()).toLocaleString()} • {l.from}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ padding:12, borderTop:"1px solid rgba(2,6,23,0.04)" }}>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => { setSelectedLead(null); }} style={{ flex:1, padding:10, borderRadius:10, border:"1px solid rgba(2,6,23,0.06)" }}>Clear</button>
              <button onClick={loadAll} style={{ flex:1, padding:10, borderRadius:10, background:"linear-gradient(90deg,#111827,#0b122b)", color:"white", border:"none" }}>Sync</button>
            </div>
          </div>
        </div>

        {/* Right column - detail + actions */}
        <div style={{ ...panelStyle, minHeight:560, padding:16, display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingBottom:6 }}>
            <div style={{ fontWeight:800 }}>Details</div>
            <div style={{ color:"#6b7280", fontSize:13 }}>{tab.toUpperCase()}</div>
          </div>

          <div style={{ display:"flex", gap:18, alignItems:"flex-start", flex:1 }}>
            {/* Left: selected lead */}
            <div style={{ flex:1, minHeight:240 }}>
              {!selectedLead ? (
                <div style={{ padding:24, ...smallMuted }}>Select a lead from the left to view full details and quick actions (reply / copy / mark called / archive).</div>
              ) : (
                <>
                  <div style={{ display:"flex", gap:12 }}>
                    <div style={{ width:84, height:84, borderRadius:12, display:"flex", alignItems:"center", justifyContent:"center", background:"linear-gradient(135deg,#a78bfa,#60a5fa)", color:"white", fontSize:28, fontWeight:800 }}>{(selectedLead.name || selectedLead.from).toString().charAt(0).toUpperCase()}</div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:18, fontWeight:800 }}>{selectedLead.name || selectedLead.from}</div>
                      <div style={{ marginTop:6, color:"#475569" }}>{selectedLead.text || "— no message —"}</div>
                      <div style={{ marginTop:8, ...smallMuted }}>{new Date(selectedLead.ts || Date.now()).toLocaleString()} • {selectedLead.from}</div>
                    </div>
                  </div>

                  <div style={{ marginTop:12 }}>
                    <textarea placeholder="Type a reply..." value={replyText} onChange={(e)=>setReplyText(e.target.value)} rows={4} style={{ width:"100%", padding:12, borderRadius:10, border:"1px solid rgba(2,6,23,0.06)" }} />
                    <div style={{ display:"flex", gap:10, marginTop:10 }}>
                      <button onClick={() => sendReply(selectedLead)} style={{ padding:"10px 14px", borderRadius:10, background:"linear-gradient(90deg,#06b6d4,#4f46e5)", color:"white", border:"none" }}>Send</button>
                      <button onClick={() => { navigator.clipboard.writeText(selectedLead.text || ""); alert("Copied message"); }} style={{ padding:"10px 14px", borderRadius:10, border:"1px solid rgba(2,6,23,0.06)" }}>Copy</button>
                      <button onClick={() => markCalled(selectedLead)} style={{ padding:"10px 14px", borderRadius:10, border:"1px solid rgba(2,6,23,0.06)" }}>Mark Called</button>
                      <button onClick={() => archiveLead(selectedLead)} style={{ padding:"10px 14px", borderRadius:10, border:"1px solid rgba(2,6,23,0.06)" }}>Archive</button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Right: contextual panel for each tab */}
            <div style={{ width:380 }}>
              {tab === "new" && (
                <div>
                  <div style={{ fontWeight:800, marginBottom:8 }}>New Car — Quick Check</div>
                  {!selectedLead ? <div style={smallMuted}>Select a new-car lead to cross-check model & price.</div> : (
                    <>
                      {/* parser */}
                      {(() => {
                        const parsed = parseNewCarRequest(selectedLead?.text || "");
                        const match = findPricingMatch(pricing as any, parsed.model, parsed.region);
                        return (
                          <div style={{ display:"grid", gap:10 }}>
                            <div style={{ padding:12, borderRadius:10, background:"#fff", boxShadow:"0 6px 18px rgba(2,6,23,0.04)" }}>
                              <div style={{ fontSize:13, color:"#6b7280" }}>Parsed</div>
                              <div style={{ fontWeight:700, marginTop:6 }}>{parsed.model || "Not found"}</div>
                              <div style={{ fontSize:13, color:"#475569", marginTop:6 }}>{parsed.suffix ? `Suffix: ${parsed.suffix}` : ""}</div>
                              <div style={{ marginTop:6, ...smallMuted }}>{parsed.region ? `Region: ${parsed.region}` : ""}</div>
                            </div>

                            <div style={{ padding:12, borderRadius:10, background:"#fff", boxShadow:"0 6px 18px rgba(2,6,23,0.04)" }}>
                              <div style={{ fontSize:13, color:"#6b7280" }}>Pricing Match</div>
                              {match ? (
                                <>
                                  <div style={{ fontWeight:700, marginTop:6 }}>{match.brand} {match.model}</div>
                                  <div style={{ fontSize:13, color:"#6b7280", marginTop:6 }}>Ex: {match.exshowroom || "—"} • On: {match.onroad || "—"}</div>
                                </>
                              ) : <div style={smallMuted}>No pricing row matched. Please open Pricing CSV or check model spelling.</div>}
                            </div>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
              )}

              {tab === "used" && (
                <div>
                  <div style={{ fontWeight:800, marginBottom:8 }}>Used Cars — Inventory</div>
                  {usedCars.length === 0 ? <div style={smallMuted}>No used cars loaded</div> : (
                    <div style={{ display:"grid", gap:8 }}>
                      {usedCars.map(u => (
                        <div key={u.id} style={{ padding:10, borderRadius:8, background:"#fff", boxShadow:"0 6px 14px rgba(2,6,23,0.03)" }}>
                          <div style={{ fontWeight:700 }}>{u.make} {u.model}</div>
                          <div style={{ fontSize:13, color:"#6b7280" }}>{u.year} • {u.price}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === "finance" && (
                <div>
                  <div style={{ fontWeight:800, marginBottom:8 }}>Finance Requests</div>
                  {financeRows.length === 0 ? <div style={smallMuted}>No finance leads</div> : (
                    financeRows.map(f => (
                      <div key={f.id} style={{ padding:10, borderRadius:8, background:"#fff", marginBottom:8 }}>
                        <div style={{ fontWeight:700 }}>{f.lead}</div>
                        <div style={{ fontSize:13, color:"#6b7280" }}>{f.amount} • {f.bank} • {f.status}</div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {tab === "sell" && (
                <div>
                  <div style={{ fontWeight:800, marginBottom:8 }}>Sell / Exchange (treated as Sell)</div>
                  <div style={smallMuted}>All exchange requests will appear here as Sell leads. Manage and reply quickly.</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1300, margin:"22px auto", textAlign:"center", color:"#94a3b8" }}>
        Multi-bot CRM • Live GPT replies • Buttons: Reply / Copy / Mark Called / Archive • Tabs: New/Used/Finance/Sell
      </div>
    </div>
  );
}
