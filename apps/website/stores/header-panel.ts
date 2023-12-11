export const useHeaderPanelStore = defineStore("header-panel", () => {
  const isOpen = ref(false);
  const toggle = () => {
    isOpen.value = !isOpen.value;
  };

  return { isOpen, toggle };
});
