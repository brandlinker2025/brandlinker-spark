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
  const netAt = listPrice => listPrice - Math.round(listPrice * discountPercent / 100);
  const priceForNet = requiredNet => {
    if (requiredNet === 0) return 0;
    let candidate = Math.ceil(requiredNet/fraction);
    // Round the discount at each candidate, as the actual storefront does.
    while (netAt(candidate) < requiredNet) candidate++;
    return candidate;
  };
  const minimumListPrice = priceForNet(cost);
  const targetListPrice = priceForNet(Math.ceil(cost/(1-targetMargin/100)));
  return {cost, discount, revenue, profit, margin, minimumListPrice, targetListPrice};
}
