// Удаление требует кличку, явное подтверждение и UUID текущей анкеты.
// Один requestId сохраняется при сетевом сбое: повтор безопасен на сервере.
export function createPetDeletion({ api, context }) {
  const $ = (id) => document.getElementById(id);
  let target = null, requestId = null, pending = false;
  function controls() {
    $("confirm-delete-pet").disabled = pending || !target ||
      $("delete-pet-name").value.trim() !== target.name ||
      !$("delete-pet-ack").checked;
    $("cancel-delete-pet").disabled = pending;
  }
  $("delete-pet").addEventListener("click", () => {
    const pet = context().pet;
    if (!pet?.profileId || !context().canDeletePet) return;
    if (target?.profileId !== pet.profileId) requestId = null;
    target = { profileId: pet.profileId, name: pet.name };
    $("delete-pet-label").textContent =
      `Для подтверждения введите кличку «${pet.name}».`;
    $("delete-pet-name").value = "";
    $("delete-pet-ack").checked = false;
    $("delete-pet-error").textContent = "";
    controls();
    $("delete-pet-dialog").showModal();
  });
  $("delete-pet-name").addEventListener("input", controls);
  $("delete-pet-ack").addEventListener("change", controls);
  $("cancel-delete-pet").addEventListener(
    "click",
    () => $("delete-pet-dialog").close(),
  );
  $("delete-pet-dialog").addEventListener("cancel", (e) => {
    if (pending) e.preventDefault();
  });
  $("delete-pet-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pending || $("confirm-delete-pet").disabled) return;
    pending = true;
    requestId ??= crypto.randomUUID();
    controls();
    $("delete-pet-error").textContent = "Удаляем анкету…";
    try {
      const result = await api("/api/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: target.profileId,
          requestId,
          confirmation: $("delete-pet-name").value.trim(),
          confirmed: true,
        }),
      });
      if (!result.deleted) {
        throw new Error(
          "Удаление не подтверждено сервером. Повторите попытку.",
        );
      }
      // Перезагрузка очищает старый кошелёк, штаб, покупки и прочие контроллеры.
      // Одноразовая пометка оставляет аккаунт свободным, без автосоздания анкеты.
      try {
        sessionStorage.setItem("dogwars:pet-deleted", "1");
      } catch {}
      window.location.reload();
    } catch (error) {
      $("delete-pet-error").textContent = error.message;
    } finally {
      pending = false;
      controls();
    }
  });
  return {
    render() {
      $("delete-pet").hidden = !context().config?.features?.deletePet ||
        !context().pet?.profileId || !context().canDeletePet;
      $("delete-pet").disabled = context().busy || pending;
    },
  };
}
