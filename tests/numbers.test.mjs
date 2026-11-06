import test from "node:test";
import assert from "node:assert/strict";
import { formatBones, fullBones, setBonesText } from "../web/numbers.mjs";

test("косточки: порог 100k и миллионы без округления в следующую единицу", () => {
  for (
    const [value, expected] of [
      [99999, "99 999"],
      [100000, "100k"],
      [125000, "125k"],
      [900000, "900k"],
      [999999, "999.99k"],
      [1000000, "1кк"],
      [1250000, "1.25кк"],
    [1150000, "1.15кк"],
      [15000000, "15кк"],
      [1000000000, "1ккк"],
      [1250000000, "1.25ккк"],
      [1000000000000, "1кккк"],
    ]
  ) {
    assert.equal(formatBones(value).replaceAll("\u00a0", " "), expected);
  }
  assert.equal(formatBones("1250000.99"), "1.25кк");
  assert.equal(formatBones(0), "0");
  assert.equal(formatBones(undefined), "—");
});

test("сокращение в подписи сохраняет полный баланс в подсказке", () => {
  const element = {
    setAttribute(name, value) {
      this[name] = value;
    },
  };
  const wallet = { balance: 1250000.75 };
  setBonesText(element, wallet.balance, "", " 🦴");
  assert.equal(element.textContent, "1.25кк 🦴");
  assert.equal(element.title, fullBones(wallet.balance) + " 🦴");
  assert.equal(element["aria-label"], element.title);
  assert.equal(wallet.balance, 1250000.75);
});
