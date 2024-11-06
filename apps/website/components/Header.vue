<script setup lang="ts">
import { useHeaderPanelStore } from "~/stores/header-panel";

const store = useHeaderPanelStore();
const { status, data } = useAuth();

const links = [
  {
    label: "Home",
    to: "/",
  },
  {
    label: "Handbook",
    to: "/handbook",
  },
  {
    label: "Briefing Generator",
    to: "/briefing-generator",
  },
];

const authLink = [
  {
    label: data.value?.user?.name,
    avatar: {
      src: data.value?.user?.image,
    },
    to: "/profile",
  },
];
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
        <UHorizontalNavigation :links="links" />
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
        <HeaderJoinButton v-if="status !== 'authenticated'" />
        <UHorizontalNavigation
          class="w-auto"
          v-if="status === 'authenticated'"
          :links="authLink"
        />
        <HeaderMenuButton
          class="lg:hidden inline-flex"
          @click="store.toggle()"
        />
      </div>
    </div>
  </nav>
</template>
