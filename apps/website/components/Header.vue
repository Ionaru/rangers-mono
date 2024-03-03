<script setup lang="ts">
import { useHeaderPanelStore } from "~/stores/header-panel";

const store = useHeaderPanelStore();
</script>

<template>
  <Banner />

  <nav
    class="bg-gray-100 dark:bg-gray-900 !bg-opacity-50 backdrop-blur border-b dark:border-gray-800 -mb-px sticky top-0 z-50"
  >
    <div
      class="mx-auto px-4 sm:px-6 lg:px-8 max-w-7xl flex items-center justify-between gap-3 h-[--header-height]"
    >
      <div class="flex items-center gap-1.5">
        <HeaderLogoLink />
      </div>
      <ul class="items-center gap-x-8 hidden lg:flex mx-8">
        <HeaderLink href="/" name="Home" />
        <HeaderLink href="/handbook" name="Handbook" />
      </ul>
      <div class="flex items-center justify-end lg:flex-1 gap-2">
        <ColorModeButton />
        <HeaderIconLink
          href="https://discord.gg/vbFMQXe"
          icon="fa-brands fa-discord"
        />
        <HeaderIconLink
          href="ts3server://ts.7th-ranger.com"
          icon="fa-brands fa-teamspeak"
        />
        <HeaderJoinButton />
        <HeaderMenuButton
          class="lg:hidden inline-flex"
          @click="store.toggle()"
        />
      </div>
    </div>
  </nav>
</template>
