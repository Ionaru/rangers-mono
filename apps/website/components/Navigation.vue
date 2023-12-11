<script setup lang="ts">
import { useHeaderPanelStore } from "~/stores/header-panel";

const store = useHeaderPanelStore();
store.isOpen = false;
</script>

<template>
  <Header />
  <USlideover v-model="store.isOpen" :appear="true">
    <Header />
    <HeaderSideMenu>
      <HeaderSideMenuLink href="/" name="Home" />
      <HeaderSideMenuLink href="/handbook" name="Handbook" />
    </HeaderSideMenu>
  </USlideover>
</template>
