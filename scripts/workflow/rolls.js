import { safeNum } from "../lib/utils.js";

export async function prepareRoll(formula, mode, rollData = {}) {
  const doRoll = async () => {
    const r = new Roll(String(formula), rollData);
    await r.evaluate();
    return r;
  };
  if (mode === "normal") return { chosen: await doRoll(), other: null, allRolls: null };
  const r1 = await doRoll();
  const r2 = await doRoll();
  const adv = mode === "adv";
  const chosen = adv ? (r1.total >= r2.total ? r1 : r2) : (r1.total <= r2.total ? r1 : r2);
  const other = chosen === r1 ? r2 : r1;
  return { chosen, other, allRolls: [r1, r2] };
}

export function makeAdjustedRoll(baseRoll, defense) {
  const finalTotal = Math.max(0, safeNum(baseRoll.total, 0) - safeNum(defense, 0));
  try {
    const data = baseRoll.toJSON();
    data.formula = `${baseRoll.formula} - ${defense}`;
    data.total = finalTotal;
    data.terms = foundry.utils.deepClone(data.terms);
    data.terms.push({ class: "OperatorTerm", operator: "-" }, { class: "NumericTerm", number: defense });
    const adjusted = Roll.fromData ? Roll.fromData(data) : Roll.fromJSON(JSON.stringify(data));
    adjusted._evaluated = true;
    adjusted._total = finalTotal;
    adjusted._formula = data.formula;
    return adjusted;
  } catch {
    baseRoll._total = finalTotal;
    baseRoll._formula = `${baseRoll.formula} - ${defense}`;
    return baseRoll;
  }
}
