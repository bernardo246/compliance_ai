# Design System — Portfólio Bernardo Cavalcanti Carneiro Leão

> Extraído do repositório [`portifolio_front`](https://github.com/bernardo246/portifolio_front)

## Filosofia visual

Minimalista, premium, futurista, elegante e escuro, inspirado em Apple, Supabase, Vercel, Stripe e Linear. Profundidade tridimensional obtida via CSS/animações (sem Three.js, exceto pequenos detalhes decorativos).

O preto domina ~95% da interface; o verde aparece apenas para destacar elementos-chave (botões, links, títulos, ícones, hover, glow).

---

## 🎨 Paleta de cores

| Token | Hex | Uso |
|---|---|---|
| `bg` | `#050505` | Fundo principal |
| `bgSecondary` | `#0B0B0B` | Fundo secundário (ex: menu mobile) |
| `card` | `#141414` | Cards |
| `borderSoft` | `#252525` | Bordas sutis |
| `textPrimary` | `#FFFFFF` | Texto principal |
| `textSecondary` | `#BDBDBD` | Texto secundário / descrições |
| `brand` | `#3ECF8E` | Verde principal (estilo Supabase) |
| `brandHover` | `#2EB67D` | Hover do verde |
| `brandGlow` | `#6EE7B7` | Glow / brilho |

### Tokens CSS (`styles/tokens.css`)

```css
:root {
  --bg: #050505;
  --bg-secondary: #0b0b0b;
  --card: #141414;
  --border-soft: #252525;
  --text-primary: #ffffff;
  --text-secondary: #bdbdbd;
  --brand: #3ecf8e;
}
```

### Tokens Tailwind (`tailwind.config.ts`)

```ts
colors: {
  bg: "#050505",
  bgSecondary: "#0B0B0B",
  card: "#141414",
  borderSoft: "#252525",
  textPrimary: "#FFFFFF",
  textSecondary: "#BDBDBD",
  brand: "#3ECF8E",
  brandHover: "#2EB67D",
  brandGlow: "#6EE7B7"
}
```

---

## ✨ Efeitos visuais assinatura

| Efeito | Implementação |
|---|---|
| Glassmorphism | `.glass-card` → `border border-borderSoft bg-white/5 backdrop-blur-xl` |
| Glow verde (sombra) | `boxShadow.glow` → `0 0 40px rgba(110, 231, 183, 0.25)` |
| Glow pulsante | keyframe `glowPulse` (2.5s, alterna entre `0 0 30px` e `0 0 55px` rgba(110,231,183, 0.2–0.35)) |
| Grid de fundo | `bg-grid` — duas linhas 1px `rgba(255,255,255,0.05)`, tile `24px 24px` |
| Blobs de luz | círculos `h-40 w-40 rounded-full bg-brand/20 blur-3xl` nos cantos |
| Radial gradients decorativos | verde em baixa opacidade (0.08–0.1), posicionados em cantos opostos |
| Flutuação | keyframe `float` (6s, `translateY(0px)` → `translateY(-10px)`) |
| Gradiente animado | keyframe `gradientShift` (8s, `backgroundPosition` 0%→100%→0%) |

### Keyframes (`tailwind.config.ts`)

```ts
animation: {
  float: "float 6s ease-in-out infinite",
  glowPulse: "glowPulse 2.5s ease-in-out infinite",
  gradientShift: "gradientShift 8s ease infinite"
},
keyframes: {
  float: {
    "0%, 100%": { transform: "translateY(0px)" },
    "50%": { transform: "translateY(-10px)" }
  },
  glowPulse: {
    "0%, 100%": { boxShadow: "0 0 30px rgba(110, 231, 183, 0.2)" },
    "50%": { boxShadow: "0 0 55px rgba(110, 231, 183, 0.35)" }
  },
  gradientShift: {
    "0%": { backgroundPosition: "0% 50%" },
    "50%": { backgroundPosition: "100% 50%" },
    "100%": { backgroundPosition: "0% 50%" }
  }
}
```

---

## 🔤 Tipografia

- Sem fonte customizada — fonte padrão do sistema (`font-sans`).
- Título de seção (`.section-title`): `text-3xl font-bold tracking-tight md:text-5xl`
- Título do Hero: `text-4xl font-black leading-tight md:text-6xl`
- Nome/logo da navbar: `text-lg font-semibold tracking-wide`
- Subtítulos de destaque: `text-lg text-brand`
- Corpo de texto: `text-textSecondary`

---

## 🧩 Classes utilitárias globais (`globals.css`)

```css
.section-container {
  @apply mx-auto max-w-6xl px-6 py-20 md:px-10;
}

.section-title {
  @apply text-3xl font-bold tracking-tight md:text-5xl;
}

.glass-card {
  @apply border border-borderSoft bg-white/5 backdrop-blur-xl;
}

.focus-ring {
  @apply focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg;
}
```

---

## 🧱 Padrões de componentes

**Botão primário**
```html
rounded-xl bg-brand px-6 py-3 font-semibold text-black transition hover:bg-brandHover
```

**Botão secundário (outline)**
```html
rounded-xl border border-borderSoft bg-white/5 px-6 py-3 font-semibold transition hover:border-brand hover:text-brand
```

**Card de vidro (padrão)**
```html
glass-card rounded-xl p-4
```

**Card de vidro (destaque, ex: foto do Hero)**
```html
glass-card relative overflow-hidden rounded-3xl p-4 shadow-glow
```

**Link de navegação**
```html
focus-ring text-sm text-textSecondary transition hover:text-brand
```

---

## 📐 Layout e grid

- Container padrão de seção: `max-w-6xl`, padding horizontal `px-6 md:px-10`, vertical `py-20`.
- Grid de cards: `grid gap-4 sm:grid-cols-2 lg:grid-cols-4`
- Hero: duas colunas em desktop (`lg:grid-cols-2`) — texto à esquerda, foto à direita com perspectiva 3D (`[perspective:1000px]`).
- Mobile-first, breakpoints padrão do Tailwind (`sm`, `md`, `lg`).

---

## 🎬 Motion

Stack: **Framer Motion** + **GSAP (ScrollTrigger)**.

Tipos de animação usados ao longo do site:
- Fade in / fade out
- Blur
- Scale
- Rotate
- TranslateY / TranslateZ
- Mouse parallax (a foto do Hero acompanha o cursor)
- Scroll parallax
- Scroll reveal (cada seção/item aparece ao entrar na viewport)
- Glow animado
- Floating animation
- Smooth scroll (`scroll-behavior: smooth` no `html`)

---

## ♿ Acessibilidade

- Navegação por teclado
- `aria-label` em todos os botões
- Contraste AA
- Foco visível (`.focus-ring`)
- HTML semântico

---

## 🛠️ Stack técnica associada

Next.js 15 (App Router) · React · TypeScript · TailwindCSS · Framer Motion · GSAP (ScrollTrigger) · Lucide React · `next/image`

---

## 📌 Referências de inspiração

Apple · Supabase · Vercel · Stripe · Linear
