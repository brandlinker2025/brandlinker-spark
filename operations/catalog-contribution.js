import { wholeCents, contribution } from "./catalog-math.mjs";
const get=id=>document.getElementById(id);
const usd=c=>"$"+(c/100).toFixed(2);
let catalog=null;
async function loadCatalog(){
 try{
  const res=await fetch("../data/products.json",{cache:"no-store"});
  if(!res.ok)throw Error("catalog request failed");
  const next=await res.json();
  if(!next||!Array.isArray(next.products))throw Error("invalid catalog");
  catalog=next;
  const sel=get("product");sel.replaceChildren();
  for(const p of next.products){if(!p||typeof p.id!=="string"||typeof p.name!=="string"||typeof p.price!=="number")continue;const option=document.createElement("option");option.value=p.id;option.textContent=p.name+" — "+usd(Math.round(p.price*100));sel.append(option);}
  if(!sel.options.length)throw Error("catalog has no priced products");
  showItem();
 }catch{get("product").replaceChildren();get("itemInfo").textContent="Could not load current product catalog. No estimates available.";get("calculate").disabled=true;}
}
function showItem(){
 const selected=catalog?.products.find(p=>p.id===get("product").value);
 if(!selected)return;
 const modes=[selected.priceStatus,selected.orderMode,selected.fulfillment?.mode].filter(v=>typeof v==="string");
 get("itemInfo").textContent="Catalog ID: "+selected.id+" | Listed: "+usd(Math.round(selected.price*100))+" | "+modes.join(" / ");
}
get("product").addEventListener("change",showItem);
get("calculate").addEventListener("click",()=>{
 const product=catalog?.products.find(p=>p.id===get("product").value);if(!product)return;
 const price=wholeCents(product.price);
 const costKeys=["cost","shipping","duty","service","returns","marketing"];
 const costs=costKeys.map(k=>wholeCents(get(k).value));
 const target=Number(get("targetMargin").value);
 if(price===null||costs.some(x=>x===null)||!Number.isFinite(target)||target<0||target>90){get("result").textContent="Enter valid non-negative cost amounts and a target margin from 0% to 90%.";return;}
 const promo=get("promo").value==="catalog";
 const estimate=contribution({price,costs,discountPercent:promo?10:0,targetMargin:target});
 const {discount,revenue,cost:landed,profit,margin,minimumListPrice,targetListPrice:suggested}=estimate;
 const lines=[
  "Product: "+product.name+" ["+product.id+"]",
  "Catalog price: "+usd(price),
  "Assumed discount: "+usd(discount),
  "Net sales revenue: "+usd(revenue),
  "Assumed total unit cost: "+usd(landed),
  "Estimated contribution: "+usd(profit),
  "Contribution margin: "+(margin===null?"N/A":margin.toFixed(2)+"%"),
  "Break-even list price: "+usd(minimumListPrice),
  "Suggested list price for "+target.toFixed(1)+"% target margin: "+usd(suggested),
  "Not verified: supplier availability, sales taxes, fulfillment, fees or promotional eligibility."
 ];
 get("result").textContent=lines.join("\n");
});
loadCatalog();