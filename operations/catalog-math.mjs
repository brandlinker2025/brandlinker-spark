export function wholeCents(value) {
  const n = Number(value);
  if (value === "" || value === null || !Number.isFinite(n) || n < 0 || n > 1e6) return null;
  return Math.round(n * 100);
}
export function contribution({ price, costs, discountPercent = 0, targetMargin = 25 }) {
  if (![price, ...costs].every(v => Number.isSafeInteger(v) && v >= 0)) throw Error("invalid amounts");
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent >= 100) throw Error("invalid discount");
  if (!Number.isFinite(targetMargin) || targetMargin < 0 || targetMargin > 90) throw Error("invalid margin");
  const cost = costs.reduce((a,b) => a+b,0);
  if (!Number.isSafeInteger(cost)) throw Error("cost overflow");
  const fraction = 1-discountPercent/100;
  const discount = Math.round(price*discountPercent/100);
  const revenue = price-discount;
  const profit = revenue-cost;
  const margin = revenue === 0 ? null : profit/revenue*100;
  const minimumListPrice = cost === 0 ? 0 : Math.ceil(cost/fraction);
  const targetListPrice = cost === 0 ? 0 : Math.ceil(cost / (fraction*(1-targetMargin/100)));
  return {cost, discount, revenue, profit, margin, minimumListPrice, targetListPrice};
}
