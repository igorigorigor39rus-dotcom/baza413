// Ограничение относится к результату, а не к исходной фотографии с камеры.
export const PHOTO_LIMIT = 1_000_000;
export async function compressPhoto(file) {
  if (file.size > 30 * 1024 * 1024) {
    throw new Error("Выберите исходное фото до 30 МБ.");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (
      !image.naturalWidth ||
      image.naturalWidth * image.naturalHeight > 50_000_000
    ) throw new Error("Выберите фотографию до 50 мегапикселей.");
    let edge = 1024;
    while (edge >= 128) {
      const scale = Math.min(
        1,
        edge / Math.max(image.naturalWidth, image.naturalHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("На устройстве недоступна обработка фото.");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [.86, .72, .55]) {
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", quality)
        );
        if (!blob) throw new Error("Не удалось преобразовать фото в JPEG.");
        if (blob.size <= PHOTO_LIMIT) return blob;
      }
      edge = Math.floor(edge * .75);
    }
    throw new Error(
      "Не удалось сжать фото до 1 МБ. Выберите другое изображение.",
    );
  } catch (error) {
    if (error.name === "EncodingError") {
      throw new Error(
        "Не удалось прочитать фото. Выберите JPEG, PNG или WebP.",
      );
    }
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}
