<script setup lang="ts">
const modelValue = defineModel<boolean>({ default: false });

withDefaults(
  defineProps<{
    label?: string;
    disabled?: boolean;
    /** 为 true 时不响应指针事件（如文件列表行点击选中） */
    passive?: boolean;
    ariaLabel?: string;
  }>(),
  {
    label: "",
    disabled: false,
    passive: false,
    ariaLabel: "",
  },
);
</script>

<template>
  <label
    class="appCheckbox"
    :class="{
      'appCheckbox--disabled': disabled,
      'appCheckbox--passive': passive,
    }"
  >
    <input
      v-model="modelValue"
      class="appCheckbox__input"
      type="checkbox"
      :disabled="disabled"
      :aria-label="ariaLabel || label || undefined"
      :tabindex="passive ? -1 : undefined"
    />
    <span v-if="label || $slots.label" class="appCheckbox__label">
      <slot name="label">{{ label }}</slot>
    </span>
  </label>
</template>

<style scoped>
.appCheckbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  font-size: 14px;
  color: var(--fg);
}

.appCheckbox--passive {
  pointer-events: none;
}

.appCheckbox--disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.appCheckbox__input {
  margin: 0;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  cursor: inherit;
}

.appCheckbox__label {
  display: inline-flex;
  line-height: 1.4;
}
</style>
