
const API_BASE="https://ukenluaihqiuwtdssatc.supabase.co/functions/v1/food-api";
const tenant=document.body.dataset.tenant;
const app=document.getElementById("app");
let catalog=null,activeCategory="all",query="",modal=null,lastAdded=null,submitting=false,success=null;
let customerName="",phone="",fulfillment="retirada",paymentMethod="pix",addressNotes="",marketingConsent=false;
const cart=[];

const uuid=()=>globalThis.crypto?.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
const money=(c=0,cur="BRL")=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:cur}).format(Number(c)/100);
const currency=()=>catalog?.tenant?.currency||"BRL";
const productMap=()=>new Map((catalog?.products||[]).map(p=>[p.id,p]));
const categoryMap=()=>new Map((catalog?.categories||[]).map(c=>[c.id,c]));
const subtotal=()=>cart.reduce((s,l)=>s+l.product.price_cents*l.quantity,0);
const itemCount=()=>cart.reduce((s,l)=>s+l.quantity,0);
const recommendedRevenue=()=>cart.reduce((s,l)=>s+(l.ruleId?l.product.price_cents*l.quantity:0),0);
const cartProductIds=()=>new Set(cart.map(l=>l.product.id));
const logoLetter=()=>String(catalog?.tenant?.display_name||catalog?.tenant?.app_name||"C").charAt(0).toUpperCase();

function addProduct(product,ruleId=null,showUpsell=false){
 const key=`${product.id}:${ruleId||"direct"}`;
 const line=cart.find(x=>x.key===key);
 if(line) line.quantity=Math.min(99,line.quantity+1); else cart.push({key,product,quantity:1,ruleId});
 if(showUpsell){lastAdded=product.id;modal="upsell"}
 render();
}
function changeQty(key,delta){
 const line=cart.find(x=>x.key===key); if(!line)return;
 line.quantity=Math.max(0,Math.min(99,line.quantity+delta));
 if(line.quantity===0)cart.splice(cart.indexOf(line),1);
 render();
}
function suggestions(){
 if(!lastAdded)return[];
 const ids=cartProductIds(),pm=productMap();
 return (catalog.recommendation_rules||[]).filter(r=>r.kind!=="cart_goal"&&r.trigger_product_id===lastAdded&&r.recommended_product_id&&!ids.has(r.recommended_product_id))
  .sort((a,b)=>(a.priority||99)-(b.priority||99)).map(r=>({rule:r,product:pm.get(r.recommended_product_id)})).filter(x=>x.product).slice(0,2);
}
function checkoutSuggestion(){
 if(!itemCount())return null;
 const ids=cartProductIds(),pm=productMap();
 const rules=(catalog.recommendation_rules||[]).filter(r=>r.kind!=="cart_goal"&&r.recommended_product_id&&!ids.has(r.recommended_product_id)&&(!r.trigger_product_id||ids.has(r.trigger_product_id))).sort((a,b)=>(a.priority||99)-(b.priority||99));
 for(const r of rules){const p=pm.get(r.recommended_product_id);if(p)return{rule:r,product:p}}
 return null;
}
function featured(){
 const pm=productMap();
 const combo=(catalog.recommendation_rules||[]).filter(r=>r.kind==="combo"&&r.recommended_product_id).sort((a,b)=>(a.priority||99)-(b.priority||99))[0];
 if(combo){const p=pm.get(combo.recommended_product_id);if(p)return{rule:combo,product:p}}
 const p=(catalog.products||[]).find(x=>x.image_url)||(catalog.products||[])[0];return p?{rule:null,product:p}:null;
}
function goal(){
 const rule=(catalog.recommendation_rules||[]).filter(r=>r.kind==="cart_goal"&&r.threshold_cents).sort((a,b)=>(a.priority||99)-(b.priority||99))[0];
 const threshold=rule?.threshold_cents||catalog.tenant.free_shipping_threshold_cents||null;
 return threshold?{threshold,remaining:Math.max(0,threshold-subtotal()),progress:Math.min(100,subtotal()/threshold*100)}:null;
}
function photoHtml(p,cls="photo"){
 const cat=categoryMap().get(p.category_id)?.name||catalog.tenant.display_name;
 return `<div class="${cls} ${p.image_url?"":"photo-fallback"}" ${p.image_url?`style="background-image:url('${esc(p.image_url)}')"`:""}>
   ${p.image_url?"":`<div class="fallback-art">${esc((p.emoji||p.name||"C").trim().charAt(0).toUpperCase())}</div>`}
   ${cls==="photo"?`<span class="badge">${esc(cat)}</span>`:""}
 </div>`;
}
function render(){
 if(!catalog)return;
 const t=catalog.tenant,s=t.storefront||{};
 document.documentElement.style.setProperty("--wine",t.accent_hex||"#6f2f35");
 document.documentElement.style.setProperty("--wine-soft",t.accent_soft_hex||"#f1e7da");
 document.title=`${t.display_name||t.app_name} — Cardápio`;
 const logoMode=s.logo_mode||"mark",subbrand=s.subbrand||"Padaria & confeitaria";
 const heroImage=s.hero_image_url||"https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=1800&q=88";
 const heroEyebrow=s.hero_eyebrow||`${t.display_name||""} • feito para o seu momento`;
 const quick=(s.quick_cards?.length===3?s.quick_cards:[
  {title:"Feito com cuidado",text:"Escolhas para diferentes momentos do dia."},
  {title:"Peça do seu jeito",text:"Retirada ou entrega em poucos passos."},
  {title:"Boas combinações",text:"Sugestões relevantes para completar o pedido."}
 ]);
 const q=query.trim().toLocaleLowerCase("pt-BR");
 const visible=(t&&catalog.products||[]).filter(p=>(activeCategory==="all"||p.category_id===activeCategory)&&(!q||`${p.name} ${p.description||""}`.toLocaleLowerCase("pt-BR").includes(q)));
 const feat=featured();
 const heroTitle=t.tagline||"Do forno para bons momentos.";
 const heroText=t.description||"Escolha seus favoritos, monte seu pedido e descubra combinações pensadas para deixar sua experiência ainda melhor.";

 app.innerHTML=`
 <div class="store-wrap">
  <header class="food-header">
   <div class="logo-wrap">
    ${t.logo_url?`<img class="logo-img ${logoMode==="wordmark"?"wordmark":""}" src="${esc(t.logo_url)}" alt="${esc(t.app_name)}">`:`<div class="logo-img" style="display:grid;place-items:center;font-family:'Playfair Display';font-weight:700;color:var(--wine)">${logoLetter()}</div>`}
    ${logoMode!=="wordmark"?`<div><div class="brand">${esc(t.display_name||t.app_name)}</div><div class="subbrand">${esc(subbrand)}</div></div>`:""}
   </div>
   <button class="ghost" id="goMenu">Cardápio</button>
  </header>
  <section class="hero" style="background-image:url('${esc(heroImage)}')">
   <div class="hero-content">
    <div class="eyebrow">${esc(heroEyebrow)}</div>
    <h1>${esc(heroTitle)}</h1>
    <p>${esc(heroText)}</p>
    <div class="hero-cta"><button class="primary" id="heroMenu">Ver cardápio</button><span class="light">Retirada ou entrega</span></div>
   </div>
  </section>
  <div class="quick">${quick.map(c=>`<div class="quick-card"><strong>${esc(c.title)}</strong><small>${esc(c.text)}</small></div>`).join("")}</div>
  <section id="menu">
   <div class="section-head">
    <div><div class="eyebrow wine-text">Cardápio</div><h2>Escolha o seu momento</h2><p>${esc(t.headline||"Escolha seus favoritos e monte seu pedido.")}</p></div>
    <input id="search" class="search" value="${esc(query)}" placeholder="Buscar no cardápio" aria-label="Buscar no cardápio">
   </div>
   <div class="cats">
    <button class="cat ${activeCategory==="all"?"active":""}" data-cat="all">Todos</button>
    ${(catalog.categories||[]).map(c=>`<button class="cat ${activeCategory===c.id?"active":""}" data-cat="${c.id}">${esc(c.name)}</button>`).join("")}
   </div>
   ${feat?`<div class="combo-strip"><div><div class="eyebrow wine-text">Sugestão ${esc(t.display_name)}</div><strong>${esc(feat.product.name)}</strong><p>${esc(feat.rule?.benefit||feat.product.description||"Uma escolha que combina com diferentes momentos do dia.")} <b>${money(feat.product.price_cents,currency())}</b></p></div><button data-featured="${feat.product.id}" data-rule="${feat.rule?.id||""}">Adicionar</button></div>`:""}
   <div class="products">${visible.map(p=>`<article class="product">${photoHtml(p)}<div class="pbody"><h3>${esc(p.name)}</h3><div class="desc">${esc(p.description||"Preparado com cuidado para o seu momento.")}</div><div class="prow"><span class="price">${money(p.price_cents,currency())}</span><button class="add" data-add="${p.id}" aria-label="Adicionar ${esc(p.name)}">+</button></div></div></article>`).join("")}</div>
   ${visible.length?"":`<div class="empty-search">Nenhum item encontrado nesta seleção.</div>`}
  </section>
 </div>
 <div class="cartbar ${itemCount()===0?"empty":""}"><div class="cartmeta"><strong>${itemCount()} ${itemCount()===1?"item":"itens"} no pedido</strong><small>Total ${money(subtotal(),currency())}${recommendedRevenue()>0?` • ${money(recommendedRevenue(),currency())} vieram de sugestões`:""}</small></div><button class="cartbtn" id="openCart">Ver pedido</button></div>
 ${renderModal()}
 `;
 wire();
}
function renderModal(){
 if(!modal)return"";
 if(modal==="upsell"){
  const ss=suggestions();if(!ss.length){modal=null;return""}
  return `<div class="overlay" data-backdrop><div class="sheet"><div class="sheet-top"><div><div class="eyebrow wine-text">Uma boa combinação</div><h2>Que tal completar o pedido?</h2><div class="lead">Algumas escolhas combinam especialmente bem com o item que você acabou de adicionar.</div></div><button class="close" data-close>×</button></div><div class="reco">${ss.map(({rule,product})=>`<div class="reco-card">${photoHtml(product,"reco-img")}<div class="reco-body"><strong>${esc(product.name)}</strong><small>+ ${money(product.price_cents,currency())}</small><button class="reco-add" data-reco="${product.id}" data-rule="${rule.id}">Adicionar ao pedido</button></div></div>`).join("")}</div><button class="secondary" data-close>Continuar sem adicionar</button></div></div>`;
 }
 if(modal==="cart"){
  const g=goal(),cs=checkoutSuggestion();
  return `<div class="overlay" data-backdrop><div class="sheet"><div class="sheet-top"><div><div class="eyebrow wine-text">Seu pedido</div><h2>${itemCount()?"Está quase pronto.":"Seu carrinho está vazio."}</h2></div><button class="close" data-close>×</button></div>
  ${g&&itemCount()?`<div class="goal"><div class="goal-top"><span>Meta promocional</span><span>${Math.round(g.progress)}%</span></div><div class="progress"><span style="width:${g.progress}%"></span></div><small>${g.remaining>0?`Faltam ${money(g.remaining,currency())} para atingir a meta do pedido.`:"Você atingiu a meta promocional deste pedido."}</small></div>`:""}
  <div class="cartlist">${cart.map(l=>`<div class="ci">${photoHtml(l.product,"ci-img")}<div><h4>${esc(l.product.name)}</h4><small>${money(l.product.price_cents,currency())} cada${l.ruleId?" • sugerido pelo sistema":""}</small></div><div class="qty"><button data-minus="${l.key}">−</button><b>${l.quantity}</b><button data-plus="${l.key}">+</button></div></div>`).join("")}</div>
  ${cs&&itemCount()?`<div class="mini-offer">${photoHtml(cs.product,"thumb")}<div><strong>Que tal incluir ${esc(cs.product.name.toLowerCase())}?</strong><small>${esc(cs.rule.benefit||"Uma última boa combinação antes do checkout.")}</small></div><button data-bump="${cs.product.id}" data-rule="${cs.rule.id}">+ ${money(cs.product.price_cents,currency())}</button></div>`:""}
  <div class="summary"><div class="sumrow"><span>Subtotal</span><b>${money(subtotal(),currency())}</b></div>${recommendedRevenue()>0?`<div class="sumrow"><span>Itens adicionados por sugestões</span><b class="green">+ ${money(recommendedRevenue(),currency())}</b></div>`:""}<div class="sumrow total"><span>Total</span><span>${money(subtotal(),currency())}</span></div></div>
  <button class="full" id="toCheckout" ${itemCount()?"":"disabled"}>Continuar para checkout</button></div></div>`;
 }
 if(modal==="checkout"){
  return `<div class="overlay"><form class="sheet" id="checkout"><div class="sheet-top"><div><div class="eyebrow wine-text">Checkout</div><h2>Como você quer receber?</h2><div class="lead">Preencha os dados para concluir seu pedido.</div></div><button class="close" type="button" id="backCart">×</button></div>
  <div class="cols"><div class="field"><label>Seu nome</label><input name="customer_name" value="${esc(customerName)}" placeholder="Nome" required maxlength="160"></div><div class="field"><label>WhatsApp</label><input name="phone" value="${esc(phone)}" placeholder="(12) 99999-9999" required maxlength="30"></div></div>
  <div class="cols"><div class="field"><label>Recebimento</label><select name="fulfillment"><option value="retirada" ${fulfillment==="retirada"?"selected":""}>Retirar no estabelecimento</option><option value="entrega" ${fulfillment==="entrega"?"selected":""}>Receber em casa</option></select></div><div class="field"><label>Pagamento</label><select name="payment_method"><option value="pix" ${paymentMethod==="pix"?"selected":""}>Pix</option><option value="cartao" ${paymentMethod==="cartao"?"selected":""}>Cartão</option><option value="dinheiro" ${paymentMethod==="dinheiro"?"selected":""}>Dinheiro</option></select></div></div>
  <div class="field"><label>Endereço / observações</label><textarea name="address_notes" rows="3" placeholder="Rua, número, bairro, complemento ou observações">${esc(addressNotes)}</textarea></div>
  <label class="consent"><input type="checkbox" name="marketing_consent" ${marketingConsent?"checked":""}><span>Quero receber promoções, ofertas e novidades da ${esc(catalog.tenant.display_name)} pelo WhatsApp. Posso cancelar quando quiser.</span></label>
  <div class="summary"><div class="sumrow total"><span>Total do pedido</span><span>${money(subtotal(),currency())}</span></div></div><div id="checkoutError"></div><button class="full" id="submitOrder" type="submit">${submitting?"Enviando pedido...":"Confirmar pedido"}</button><button class="secondary" type="button" id="backCart2">Voltar ao pedido</button></form></div>`;
 }
 if(modal==="done"&&success){
  return `<div class="overlay"><div class="sheet done-sheet"><div class="done-icon">✓</div><div class="eyebrow wine-text">Pedido recebido</div><h2>Perfeito. Agora é com a ${esc(catalog.tenant.display_name)}.</h2><div class="lead">Seu pedido foi registrado com sucesso.${success.order_id?` Número: <b>${esc(success.order_id.slice(0,8).toUpperCase())}</b>`:""}</div><div class="order-total">${money(success.total_cents||0,success.currency||currency())}</div><button class="full" id="done">Voltar ao cardápio</button></div></div>`;
 }
 return"";
}
function wire(){
 document.getElementById("goMenu")?.addEventListener("click",()=>document.querySelector("#menu")?.scrollIntoView({behavior:"smooth"}));
 document.getElementById("heroMenu")?.addEventListener("click",()=>document.querySelector("#menu")?.scrollIntoView({behavior:"smooth"}));
 document.getElementById("search")?.addEventListener("input",e=>{query=e.target.value;render()});
 document.querySelectorAll("[data-cat]").forEach(b=>b.onclick=()=>{activeCategory=b.dataset.cat;render()});
 document.querySelectorAll("[data-add]").forEach(b=>b.onclick=()=>{const p=productMap().get(b.dataset.add);if(p)addProduct(p,null,true)});
 document.querySelectorAll("[data-featured]").forEach(b=>b.onclick=()=>{const p=productMap().get(b.dataset.featured);if(p)addProduct(p,b.dataset.rule||null,false)});
 document.getElementById("openCart")?.addEventListener("click",()=>{modal="cart";render()});
 document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>{modal=null;render()});
 document.querySelectorAll("[data-backdrop]").forEach(x=>x.addEventListener("mousedown",e=>{if(e.target===x){modal=null;render()}}));
 document.querySelectorAll("[data-reco]").forEach(b=>b.onclick=()=>{const p=productMap().get(b.dataset.reco);if(p){addProduct(p,b.dataset.rule,false);modal=null;render()}});
 document.querySelectorAll("[data-minus]").forEach(b=>b.onclick=()=>changeQty(b.dataset.minus,-1));
 document.querySelectorAll("[data-plus]").forEach(b=>b.onclick=()=>changeQty(b.dataset.plus,1));
 document.querySelectorAll("[data-bump]").forEach(b=>b.onclick=()=>{const p=productMap().get(b.dataset.bump);if(p){addProduct(p,b.dataset.rule,false);modal="cart";render()}});
 document.getElementById("toCheckout")?.addEventListener("click",()=>{modal="checkout";render()});
 document.getElementById("backCart")?.addEventListener("click",()=>{modal="cart";render()});
 document.getElementById("backCart2")?.addEventListener("click",()=>{modal="cart";render()});
 document.getElementById("checkout")?.addEventListener("submit",submitOrder);
 document.getElementById("done")?.addEventListener("click",()=>{success=null;modal=null;render()});
}
async function submitOrder(e){
 e.preventDefault();if(submitting||!itemCount())return;
 const fd=new FormData(e.currentTarget);
 customerName=String(fd.get("customer_name")||"");phone=String(fd.get("phone")||"");
 fulfillment=String(fd.get("fulfillment")||"retirada");paymentMethod=String(fd.get("payment_method")||"pix");
 addressNotes=String(fd.get("address_notes")||"");marketingConsent=fd.get("marketing_consent")==="on";
 submitting=true;render();
 let session=localStorage.getItem("deskcomm-food-session");if(!session){session=uuid();localStorage.setItem("deskcomm-food-session",session)}
 try{
  const r=await fetch(`${API_BASE}/${encodeURIComponent(tenant)}`,{method:"POST",headers:{"content-type":"application/json","accept":"application/json"},body:JSON.stringify({
   idempotency_key:uuid(),session_key:session,customer_name:customerName,phone,fulfillment,payment_method:paymentMethod,address_notes:fulfillment==="entrega"?addressNotes:"",marketing_consent:marketingConsent,
   items:cart.map(l=>({product_id:l.product.id,quantity:l.quantity,modifier_ids:[],recommendation_rule_id:l.ruleId}))
  })});
  const data=await r.json();if(!r.ok)throw new Error(data.error||data.message||"Não foi possível concluir o pedido.");
  success={...data,total_cents:data.total_cents??subtotal(),currency:data.currency??currency()};cart.splice(0,cart.length);modal="done";
 }catch(err){
  submitting=false;render();const box=document.getElementById("checkoutError");if(box)box.innerHTML=`<div class="checkout-error">${esc(err.message||"Não foi possível concluir o pedido.")}</div>`;return;
 }
 submitting=false;render();
}
async function init(){
 app.innerHTML=`<div class="loading"><div class="spinner"></div><p>Carregando cardápio…</p></div>`;
 try{
  const r=await fetch(`${API_BASE}/${encodeURIComponent(tenant)}`,{headers:{accept:"application/json"}});
  const data=await r.json();if(!r.ok||!data?.tenant)throw new Error(data?.error||"Cardápio indisponível.");
  catalog=data;render();
 }catch(err){
  app.innerHTML=`<div class="fatal"><h1>Cardápio indisponível</h1><p>${esc(err.message)}</p><button onclick="location.reload()">Tentar novamente</button></div>`;
 }
}
init();
