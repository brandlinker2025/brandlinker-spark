// All money is integer minor units (cents for USD, paisa for BDT). No floats in arithmetic.

export function toMinor(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error("Invalid amount."), { status: 400 });
  return Math.round(n * 100);
}

export function fromMinor(minor) {
  return Number((minor / 100).toFixed(2));
}

export function isMinor(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

/** Integer percentage of an integer amount, rounded half up. */
export function percentOf(minor, percent) {
  return Math.round((minor * percent) / 100);
}

/** Convert USD cents to BDT paisa with a fixed rate expressed as a decimal (e.g. 124.75). */
export function usdCentsToBdtPaisa(cents, rate) {
  const rateMilli = Math.round(Number(rate) * 1000); // 124750
  return Math.round((cents * rateMilli) / 1000);
}

/**
 * Landed cost = product cost + shipping + duties + fees (all minor units, same currency).
 */
export function landedCost({ productCost, shipping = 0, duties = 0, fees = 0 }) {
  for (const [k, v] of Object.entries({ productCost, shipping, duties, fees })) {
    if (!isMinor(v)) throw Object.assign(new Error(`${k} must be a non-negative integer in minor units.`), { status: 400 });
  }
  return productCost + shipping + duties + fees;
}

/**
 * Margin of a sale price over landed cost.
 * marginBps = basis points of the sale price (10000 = 100%). Negative margin is reported, not hidden.
 */
export function margin({ salePrice, landed }) {
  if (!isMinor(salePrice) || !isMinor(landed)) throw Object.assign(new Error("Amounts must be integer minor units."), { status: 400 });
  const marginMinor = salePrice - landed;
  const marginBps = salePrice === 0 ? null : Math.round((marginMinor * 10000) / salePrice);
  return { salePrice, landed, marginMinor, marginBps, profitable: marginMinor > 0 };
}
