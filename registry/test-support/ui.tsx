import * as React from "react";

type ElementProps<T extends keyof React.JSX.IntrinsicElements> = React.JSX.IntrinsicElements[T];

export function Button({
  variant: _variant,
  size: _size,
  ...props
}: ElementProps<"button"> & { variant?: string; size?: string }) {
  return <button {...props} />;
}
export function Badge({
  variant: _variant,
  ...props
}: ElementProps<"span"> & { variant?: string }) {
  return <span {...props} />;
}
export function NativeSelect(props: ElementProps<"select">) {
  return <select {...props} />;
}
export function NativeSelectOption(props: ElementProps<"option">) {
  return <option {...props} />;
}
export function Table(props: ElementProps<"table">) {
  return <table {...props} />;
}
export function TableHeader(props: ElementProps<"thead">) {
  return <thead {...props} />;
}
export function TableBody(props: ElementProps<"tbody">) {
  return <tbody {...props} />;
}
export function TableRow(props: ElementProps<"tr">) {
  return <tr {...props} />;
}
export function TableHead(props: ElementProps<"th">) {
  return <th {...props} />;
}
export function TableCell(props: ElementProps<"td">) {
  return <td {...props} />;
}
export function Separator(props: ElementProps<"div">) {
  return <div role="separator" {...props} />;
}
