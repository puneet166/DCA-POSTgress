// src/lib/precision.js
// Helpers to round amounts to market precision and compute min-notional amounts.

function pow10(n){
  return Math.pow(10, n);
}

/**
 * roundDownToPrecision
 * - Round DOWN an amount to the allowed decimal precision (number of decimals)
 * - If precision is null/undefined, returns amount unchanged
 */
function roundDownToPrecision(amount, precision){
  if(precision == null) return amount;
  const factor = pow10(precision);
  return Math.floor(amount * factor) / factor;
}

/**
 * roundUpToPrecision
 * - Round UP an amount to the allowed decimal precision (number of decimals)
 */
function roundUpToPrecision(amount, precision){
  if(precision == null) return amount;
  const factor = pow10(precision);
  return Math.ceil(amount * factor) / factor;
}

/**
 * formatToPrecisionStr
 * - returns string representation with given decimal places without introducing floating noise
 */
function formatToPrecisionStr(amount, precision){
  if(precision == null) return String(amount);
  // use toFixed to ensure required decimals, then strip trailing zeros if desired
  return Number(amount).toFixed(precision);
}

/**
 * computeAmountToMeetMinNotional
 * - Given price, desiredAmount and market info, compute an adjusted amount that:
 *    * is >= market.limits.amount.min (if present)
 *    * has the correct decimal precision
 *    * is >= minNotional/price (rounded UP)
 * - Returns adjusted amount (Number) or null if unable
 */
function computeAmountToMeetMinNotional({
  desiredAmount,
  price,
  market // ccxt market object
}) {
  if(!market) return desiredAmount;

  const precision = market.precision && market.precision.amount != null ? market.precision.amount : null;
  // min amount from market.limits.amount.min
  const minAmount = market.limits && market.limits.amount && market.limits.amount.min ? Number(market.limits.amount.min) : null;
  // min notional / cost (in quote currency) for min order value
  const minNotional = (market.limits && market.limits.cost && market.limits.cost.min)
    ? Number(market.limits.cost.min)
    : (market.limits && market.limits.notional && market.limits.notional.min)
      ? Number(market.limits.notional.min)
      : null;

  // Start with rounding down of desiredAmount to precision to ensure valid step
  let amt = desiredAmount;
  if(precision != null){
    amt = roundDownToPrecision(amt, precision);
  }

  // If a minNotional exists and price > 0, compute required amount to reach it
  if(minNotional && price && price > 0){
    const required = minNotional / price;
    // round up to precision
    const requiredRounded = precision != null ? roundUpToPrecision(required, precision) : required;
    if(amt < requiredRounded) amt = requiredRounded;
  }

  // enforce minAmount
  if(minAmount != null){
    const minAmtRounded = precision != null ? roundUpToPrecision(minAmount, precision) : minAmount;
    if(amt < minAmtRounded) amt = minAmtRounded;
  }

  // final rounding down to precision (in case we exceeded precision by math)
  if(precision != null) amt = roundDownToPrecision(amt, precision);

  // If still non-positive or NaN -> return null to indicate invalid
  if(!amt || isNaN(amt) || amt <= 0) return null;
  return amt;
}

module.exports = {
  roundDownToPrecision,
  roundUpToPrecision,
  formatToPrecisionStr,
  computeAmountToMeetMinNotional
};
