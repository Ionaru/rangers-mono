<script setup lang="ts">
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import HeaderIconButton from "~/components/HeaderIconButton.vue";

const colorMode = useColorMode();

const isDark = computed({
  get() {
    return colorMode.value === "dark";
  },
  set() {
    colorMode.preference = colorMode.value === "dark" ? "light" : "dark";
  },
});
</script>

<template>
  <clientOnly>
    <HeaderIconButton @click="isDark = !isDark">
      <FontAwesomeIcon
        icon="fa-solid fa-moon"
        fixed-width
        v-if="isDark"
        size="lg"
      />
      <FontAwesomeIcon
        icon="fa-solid fa-sun"
        fixed-width
        v-if="!isDark"
        size="lg"
      />
    </HeaderIconButton>

    <template #fallback>
      <HeaderIconButton :disabled="true">
        <FontAwesomeIcon
          icon="fa-solid fa-spinner"
          fixed-width
          spin
          size="lg"
        />
      </HeaderIconButton>
    </template>
  </clientOnly>
</template>
