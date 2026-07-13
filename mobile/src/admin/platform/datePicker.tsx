// Date entry — Phase-0 form: a plain YYYY-MM-DD text field on every
// platform (matches the API's MYT date-key format). Phase 2 (Drivers'
// leave calendar, Trucks' document renewal) upgrades this to a real
// platform picker behind the same props, so call sites won't change.
import React from "react";
import { Input } from "../components/ui";

export function DateField({
  label,
  value,
  onChange,
  placeholder = "YYYY-MM-DD",
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return <Input label={label} value={value} onChange={onChange} placeholder={placeholder} />;
}
