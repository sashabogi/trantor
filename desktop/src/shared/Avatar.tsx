// Monogram avatars on deterministic per-brand hues — Buzz's avatars carry the personality of the
// whole app, and ours do the same job with zero asset pipeline: the same name is the same color on
// every machine, in every view.
export function hueOf(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({ name, size = 52 }: { name: string; size?: number }) {
  const h = hueOf(name);
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full font-semibold"
          style={{
            width: size, height: size, fontSize: size * 0.36,
            background: `hsl(${h} 32% 26%)`, color: `hsl(${h} 55% 72%)`,
          }}>
      {name.slice(0, 2)}
    </span>
  );
}
