// Generates assets/icon.png and assets/splash-icon.png
// Run with: bun run generate-icon.ts

import { createCanvas } from "canvas";
import { writeFileSync } from "fs";

function drawIcon(size: number): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const cx = size / 2;
  const cy = size / 2;

  // Background
  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, size, size);

  // Rounded background square (slightly lighter)
  const pad = size * 0.08;
  const r = size * 0.22;
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.roundRect(pad, pad, size - pad * 2, size - pad * 2, r);
  ctx.fill();

  // Microphone body
  const micW = size * 0.18;
  const micH = size * 0.28;
  const micR = micW / 2;
  const micTop = cy - size * 0.22;

  ctx.fillStyle = "#4f8ef7";
  ctx.beginPath();
  ctx.roundRect(cx - micW / 2, micTop, micW, micH, micR);
  ctx.fill();

  // Microphone stand arc
  const arcR = size * 0.2;
  const arcY = micTop + micH;
  ctx.strokeStyle = "#4f8ef7";
  ctx.lineWidth = size * 0.045;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, arcY - arcR * 0.15, arcR, Math.PI * 0.1, Math.PI * 0.9, false);
  ctx.stroke();

  // Stand pole
  ctx.beginPath();
  ctx.moveTo(cx, arcY + arcR * 0.75);
  ctx.lineTo(cx, arcY + arcR * 0.75 + size * 0.06);
  ctx.stroke();

  // Base line
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.12, arcY + arcR * 0.75 + size * 0.06);
  ctx.lineTo(cx + size * 0.12, arcY + arcR * 0.75 + size * 0.06);
  ctx.stroke();

  return canvas.toBuffer("image/png");
}

const icon = drawIcon(1024);
writeFileSync("assets/icon.png", icon);
writeFileSync("assets/splash-icon.png", icon);
writeFileSync("assets/adaptive-icon.png", icon);
console.log("✓ Generated assets/icon.png, splash-icon.png, adaptive-icon.png");
