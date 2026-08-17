
const API_BASE="https://ukenluaihqiuwtdssatc.supabase.co/functions/v1/food-api";
const tenant=document.body.dataset.tenant;
const app=document.getElementById("app");
let catalog=null,active="all",search="",submitting=false;
const cart=new Map();
const uuid=()=>globalThis.crypto?.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
const money=(c=0,cur="BRL")=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:cur}).format(Number(c)/100);
const count=()=>[...cart.values()].reduce((s,x)=>s+x.qty,0);
const total=()=>[...cart.values()].reduce((s,x)=>s+x.product.price_cents*x.qty,0);

function productCard(p){
 return `<article class="product"><div class="media">${p.image_url?`<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy">`:`<div class="emoji">${esc(p.emoji||"🍽️")}</div>`}</div><div class="copy"><h2>${esc(p.name)}</h2>${p.description?`<p>${esc(p.description)}</p>`:""}<div class="row"><strong>${money(p.price_cents,catalog.tenant.currency||"BRL")}</strong><button data-add="${p.id}">Adicionar</button></div></div></article>`;
}
function render(){
 const t=catalog.tenant;
 document.documentElement.style.setProperty("--accent",t.accent_hex||"#275d4d");
 document.documentElement.style.setProperty("--soft",t.accent_soft_hex||"#efe6d8");
 document.title=`${t.display_name||t.app_name} — Cardápio`;
 const q=search.trim().toLocaleLowerCase("pt-BR");
 const products=(catalog.products||[]).filter(p=>(active==="all"||p.category_id===active)&&(!q||`${p.name} ${p.description||""}`.toLocaleLowerCase("pt-BR").includes(q)));
 app.innerHTML=`<header class="hero"><div class="hero-inner"><div class="logo">${t.logo_url?`<img src="${esc(t.logo_url)}" alt="">`:"🍽️"}</div><div><div class="eyebrow">CARDÁPIO DIGITAL</div><h1>${esc(t.display_name||t.app_name)}</h1><p>${esc(t.tagline||t.description||"Escolha seus favoritos e monte seu pedido.")}</p></div></div></header><section class="toolbar"><div class="toolbar-in"><input id="search" class="search" value="${esc(search)}" placeholder="Buscar no cardápio…" autocomplete="off"><div class="cats"><button class="chip ${active==="all"?"active":""}" data-cat="all">Todos</button>${(catalog.categories||[]).map(c=>`<button class="chip ${active===c.id?"active":""}" data-cat="${c.id}">${esc(c.name)}</button>`).join("")}</div></div></section><main class="main"><div class="grid">${products.map(productCard).join("")}</div>${products.length?"":`<div class="empty">Nenhum item encontrado.</div>`}</main><button id="cartbar" class="cartbar" ${count()?"":"hidden"}><span><strong>${count()} ${count()===1?"item":"itens"}</strong><small>Ver pedido</small></span><strong>${money(total(),t.currency||"BRL")}</strong></button><div id="drawer" class="drawer"><div class="backdrop" data-close></div><section class="sheet"><button class="close" data-close>×</button><div id="cartContent"></div></section></div>`;
 document.getElementById("search").oninput=e=>{search=e.target.value;render()};
 document.querySelectorAll("[data-cat]").forEach(b=>b.onclick=()=>{active=b.dataset.cat;render()});
 document.querySelectorAll("[data-add]").forEach(b=>b.onclick=()=>add(b.dataset.add));
 document.getElementById("cartbar")?.addEventListener("click",openCart);
 document.querySelectorAll("[data-close]").forEach(x=>x.onclick=closeCart);
}
function recommendation(productId){
 const inCart=new Set(cart.keys());
 return (catalog.recommendation_rules||[]).filter(r=>r.trigger_product_id===productId&&r.recommended_product_id&&!inCart.has(r.recommended_product_id)).sort((a,b)=>(a.priority||99)-(b.priority||99)).map(r=>({rule:r,product:catalog.products.find(p=>p.id===r.recommended_product_id)})).find(x=>x.product)||null;
}
function add(id){
 const p=catalog.products.find(x=>x.id===id); if(!p)return;
 const c=cart.get(id); cart.set(id,{product:p,qty:Math.min(99,(c?.qty||0)+1)}); render();
 const rec=recommendation(id);
 if(rec) setTimeout(()=>{if(confirm(`${rec.rule.benefit||"Que tal completar o pedido?"}\n\nAdicionar ${rec.product.name} por ${money(rec.product.price_cents,catalog.tenant.currency||"BRL")}?`)){const x=cart.get(rec.product.id);cart.set(rec.product.id,{product:rec.product,qty:Math.min(99,(x?.qty||0)+1)});render()}},80);
}
function qty(id,delta){const x=cart.get(id);if(!x)return;const n=x.qty+delta;if(n<=0)cart.delete(id);else cart.set(id,{...x,qty:Math.min(99,n)});render();openCart()}
function openCart(){document.getElementById("drawer")?.classList.add("open");renderCart()}
function closeCart(){document.getElementById("drawer")?.classList.remove("open")}
function renderCart(){
 const el=document.getElementById("cartContent");if(!el)return;
 if(!count()){el.innerHTML=`<h2>Seu pedido</h2><div class="empty">Seu carrinho está vazio.</div>`;return}
 el.innerHTML=`<h2>Seu pedido</h2><div>${[...cart.entries()].map(([id,x])=>`<div class="line"><div><strong>${esc(x.product.name)}</strong><small>${money(x.product.price_cents,catalog.tenant.currency||"BRL")} cada</small></div><div class="qty"><button data-minus="${id}">−</button><span>${x.qty}</span><button data-plus="${id}">+</button></div></div>`).join("")}</div><div class="total"><span>Total</span><strong>${money(total(),catalog.tenant.currency||"BRL")}</strong></div><form id="checkout"><input name="customer_name" required maxlength="160" placeholder="Seu nome"><input name="phone" required maxlength="30" inputmode="tel" placeholder="WhatsApp com DDD"><div class="two"><select name="fulfillment"><option value="retirada">Retirada</option><option value="entrega">Entrega</option></select><select name="payment_method"><option value="pix">Pix</option><option value="cartao">Cartão</option><option value="dinheiro">Dinheiro</option></select></div><textarea name="address_notes" maxlength="500" placeholder="Endereço / observações"></textarea><label class="consent"><input type="checkbox" name="marketing_consent"> Aceito receber novidades e ofertas.</label><button id="submit" class="submit" type="submit">Finalizar pedido</button><div id="formMessage" class="form-message"></div></form>`;
 el.querySelectorAll("[data-minus]").forEach(b=>b.onclick=()=>qty(b.dataset.minus,-1));el.querySelectorAll("[data-plus]").forEach(b=>b.onclick=()=>qty(b.dataset.plus,1));document.getElementById("checkout").onsubmit=checkout;
}
async function checkout(e){
 e.preventDefault();if(submitting)return;submitting=true;
 const btn=document.getElementById("submit"),msg=document.getElementById("formMessage");btn.disabled=true;btn.textContent="Enviando…";msg.textContent="";
 const fd=new FormData(e.currentTarget);let session=localStorage.getItem("deskcomm-food-session");if(!session){session=uuid();localStorage.setItem("deskcomm-food-session",session)}
 const body={idempotency_key:uuid(),session_key:session,customer_name:String(fd.get("customer_name")||""),phone:String(fd.get("phone")||""),fulfillment:String(fd.get("fulfillment")||"retirada"),payment_method:String(fd.get("payment_method")||"pix"),address_notes:String(fd.get("address_notes")||""),marketing_consent:fd.get("marketing_consent")==="on",items:[...cart.values()].map(x=>({product_id:x.product.id,quantity:x.qty,modifier_ids:[]}))};
 try{const r=await fetch(`${API_BASE}/${encodeURIComponent(tenant)}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||"Não foi possível criar o pedido.");cart.clear();const el=document.getElementById("cartContent");el.innerHTML=`<div class="success"><div>✓</div><h2>Pedido criado!</h2><p>Recebemos seu pedido com sucesso.</p>${data.order_number?`<strong>Nº ${esc(data.order_number)}</strong>`:""}<br><br><button id="done">Continuar</button></div>`;document.getElementById("done").onclick=()=>{closeCart();render()}}
 catch(err){msg.textContent=err.message||"Falha ao finalizar pedido."}
 finally{submitting=false;btn.disabled=false;btn.textContent="Finalizar pedido"}
}
async function init(){
 app.innerHTML=`<div class="loading"><div class="spinner"></div><p>Carregando cardápio…</p></div>`;
 try{const r=await fetch(`${API_BASE}/${encodeURIComponent(tenant)}`,{headers:{accept:"application/json"}});const data=await r.json();if(!r.ok||!data?.tenant)throw new Error(data?.error||"Cardápio indisponível.");catalog=data;render()}
 catch(err){app.innerHTML=`<div class="fatal"><h1>Cardápio indisponível</h1><p>${esc(err.message)}</p><button onclick="location.reload()">Tentar novamente</button></div>`}
}
init();
