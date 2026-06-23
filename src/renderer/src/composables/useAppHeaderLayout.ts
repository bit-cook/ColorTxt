import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  HEADER_COMPACT_FONT_BREAKPOINT,
  HEADER_COMPACT_FORMAT_BREAKPOINT,
} from "../constants/appHeaderLayout";

export function useAppHeaderLayout() {
  const windowWidth = ref(
    typeof window !== "undefined" ? window.innerWidth : 1200,
  );

  const compactFontToolbar = computed(
    () => windowWidth.value < HEADER_COMPACT_FONT_BREAKPOINT,
  );
  const compactFormatToolbar = computed(
    () => windowWidth.value < HEADER_COMPACT_FORMAT_BREAKPOINT,
  );

  function onResize() {
    windowWidth.value = window.innerWidth;
  }

  onMounted(() => {
    window.addEventListener("resize", onResize, { passive: true });
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", onResize);
  });

  return {
    compactFontToolbar,
    compactFormatToolbar,
  };
}
