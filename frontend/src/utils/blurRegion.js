export const blurRegion = (ctx, video, canvas, x, y, w, h) => {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.filter = "blur(30px)";
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  ctx.restore();
};
