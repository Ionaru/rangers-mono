<script setup lang="ts">
import PrimaryButton from "~/components/PrimaryButton.vue";

definePageMeta({ auth: false });

const utcDate = new Date(
  new Date().toLocaleString("en-US", { timeZone: "UTC" }),
);
const tzDate = new Date(
  new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }),
);
const timezone =
  (tzDate.getTime() - utcDate.getTime()) / 6e4 / 60 === 1 ? "CET" : "CEST";
</script>
<template>
  <NuxtLayout>
    <Jumbotron>
      <Container>
        <heading1>About our Community</heading1>
        <p>
          7th Ranger Group is an international Arma 3 Milsim community based in
          Europe, but with members from all over the world. Our focus in the
          game is on overcoming challenges together by coordinated and tactical
          team play. Fast and easy is not our style. We rely on planning,
          communication and deployment of adapted military tactics. While we
          enjoy more realistic aspects of the game, they have to be beneficial
          to the gameplay experience.
        </p>
        <hr
          class="my-6 h-0.5 border-t-0 bg-neutral-200 opacity-100 dark:opacity-30"
        />
        <p>
          With our training and mentoring system we provide an accessible and
          immersive experience both for experienced and inexperienced members.
          We continuously support our members as they strive to improve. Every
          new member will receive extensive mentoring to ensure his smooth
          integration into our unit.
        </p>
      </Container>
    </Jumbotron>
    <Container>
      <img src="/images/group.webp" alt="Arma 3" class="w-full" />
    </Container>
    <Jumbotron>
      <Container>
        <heading1>Our Operations</heading1>
        <p>Saturdays at 20:00 {{ timezone }}</p>
      </Container>
    </Jumbotron>
    <Container
      class="grid grid-cols-1 grid-rows-4 gap-4 md:grid-rows-2 md:grid-cols-2"
    >
      <InfoCard heading="Mission framework" icon="code">
        In-house created custom Mission Framework to allow for diverse,
        immersive and challenging missions.
      </InfoCard>
      <InfoCard heading="Training sessions" icon="handshake-angle">
        Weekly and demand based Training Sessions. Including Rotary Training and
        Qualification Trainings.
      </InfoCard>
      <InfoCard heading="Enhanced AI" icon="lightbulb">
        Custom AI enhancements to allow for a better coordinated and responsive
        AI providing a dynamic and challenging battle.
      </InfoCard>
      <InfoCard heading="Structured environment" icon="sitemap">
        Prepared loadouts, streamlined customizations and structured procedure
        for less time at base and more time in the field.
      </InfoCard>
    </Container>
    <Jumbotron>
      <Container
        class="flex flex-col md:grid md:grid-cols-2 md:grid-rows-1 items-center gap-x-8"
      >
        <YouTube class="w-full h-full" link="" />
        <div class="flex flex-col items-start">
          <Heading1>Our take on Milsim</Heading1>
          <p class="text-left">
            While we do enjoy a realistic simulation, we simplify it where it
            does not benefit our gameplay. Player experience is more important
            than real life military procedures. Therefore, we do not use a
            ranking system and unnecessarily strict discipline. We use a
            modified basic medical system (modified ACE Basic Medical). On the
            other hand we only allow first-person perspective and regulate
            equipment to facilitate team play. Furthermore, we do not have
            dedicated roles. Instead, we trust in our members to take roles they
            are capable of fulfilling by themselves, aided by our Training
            System. We are mainly infantry-focused, but not limited to.
          </p>
        </div>
      </Container>
    </Jumbotron>
    <Container>
      <img src="/images/heli.webp" alt="Promo image" class="w-full" />
    </Container>
    <Jumbotron>
      <Container>
        <heading1>Our Resources</heading1>
        <p>
          The unit has multiple resources at its disposal to ensure smooth
          operations. These resources include: a dedicated Arma 3 server as well
          as a custom-made bot for general unit administration. The unit also
          makes use of a carefully tailored modset to enhance the gameplay
          experience for the community. These mods (Totaling around 50GB)
          include but are not limited to: ACRE2, ACE3, RHS Escalation as well as
          a number of smaller and custom-made mods designed to bring out the
          best experience.
        </p>
      </Container>
    </Jumbotron>
    <Container
      class="grid grid-cols-1 grid-rows-4 gap-4 md:grid-rows-2 md:grid-cols-2"
    >
      <InfoCard heading="Steam workshop" icon="cloud-arrow-down">
        We are using the Steam workshop for easy mod distribution and update
        management.
      </InfoCard>
      <InfoCard heading="Custom medical system" icon="heart-pulse">
        We are using a Custom Medical System based on ACE3 Basic Medical System
        with expanded features like poisoning.
      </InfoCard>
      <InfoCard heading="Custom AI modifications" icon="gears">
        We are using AI modifications and equipment balancing to further
        increase the gameplay experience in our operations.
      </InfoCard>
      <InfoCard heading="Quality of life" icon="user-clock">
        We have multiple custom modifications to improve the quality of life by
        eliminating unnecessary mechanics.
      </InfoCard>
    </Container>
    <Jumbotron>
      <Container class="flex items-center gap-x-8">
        <div class="flex flex-col items-start">
          <Heading1>Our Expectations</Heading1>
          <p class="text-left">
            We are looking for mature people who share our enthusiasm for
            overcoming challenges by team play and tactics. That requires a
            basic willingness to improve. The key is improvement, we do not
            expect any previous experience, we will gladly support each other on
            our journey forward. In addition, we expect an average attendance of
            once per week or a leave of absence.
          </p>
          <br />
          <p class="text-left">
            Communication and capacity for teamwork are crucial. Every new
            member will undergo a mentoring program where he will be taught the
            basic on how we operate. At the end of a trial period, each Recruit
            has to complete our Infantry Qualification Course to become a full
            member.
          </p>
        </div>
        <img src="/images/ii1.jpg" alt="Promo image" class="w-1/3" />
      </Container>
    </Jumbotron>
    <Container>
      <img src="/images/hummvee.webp" alt="Promo image" class="w-full" />
    </Container>
    <Jumbotron>
      <Container>
        <heading1>How to join</heading1>
        <p>
          We are always looking for friendly, mature and respectful players. If
          you want to become a part of our community you can leave an
          application. A Recruiter will process your application and guide you
          through our process.
        </p>
        <a class="mt-4 block" href="https://discord.gg/vbFMQXe">
          <PrimaryButton>Submit application</PrimaryButton>
        </a>
      </Container>
    </Jumbotron>
    <Container>
      <img src="/images/boom.webp" alt="Promo image" class="w-full" />
    </Container>
    <Jumbotron>
      <Container>
        <heading1>Would you like to know more?</heading1>
        <p>
          Feel free to drop by on our Discord if you have any remaining
          questions. You can also have a look at our handbook to learn more
          about our procedures and tactics. We are looking forward to your
          visit!
        </p>
        <div>
          <a class="mt-4 block" href="https://discord.gg/vbFMQXe">
            <PrimaryButton>Join Discord</PrimaryButton>
          </a>
        </div>
      </Container>
    </Jumbotron>
  </NuxtLayout>
</template>
