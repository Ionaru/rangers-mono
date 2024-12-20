---
title: Fixed Wing Addendum
---

# Fixed Wing Addendum

## Preflight checklist

This preflight checklist expects the pilot to have experience in handling a fixed wing aircraft and to have fully configured the controls in arma3 before entering the plane and taking off.

This includes but is not limited to:

- Flaps
- Gear up/down
- Speedbrake
- Throttle
- Targeting camera
- Targeting and locking on (Next Vehicle Target R and Target T)
- Countermeasures
- Tailhook
- Inside the cockpit select

It is prohibited to enter a plane without making sure all controls necessary for the safe operation of the aircraft (configured in single player or on the training server) are present.

1. Make sure you have your 152, MicroDAGR and parachute equipped.
   - enter the plane, check for damage status and fuel
   - apply zero collective (engine must remain off during preflight sequence)
   - do not turn on the engine or move the plane until rearming has concluded
     - Note: the next steps can be performed during re-arming the plane.
2. Connect to the onboard radio (ACE interact, DASH, use) and configure it:
   - Switch to airnet-1 (the radio channel of the forward air controller)
   - Optional: configure the onboard radio for your left/right ear only.
   - Sign on to airnet-1:
     1. You: FAC, this is whiskey-1.
     2. Controller: Send for FAC.
     3. You: FAC, whiskey-1 signing on airnet-1.
     4. Controller: FAC copies.
   - Optional: Set up airnet-2 on the second onboard radio to talk to other pilots
   - Optional: Configure the airnet-2 radio for your right/left ear only.
3. Set up your sensors
   - make sure you have one of your radars set at a minimum 8km
   - display your GPS/MicroDAGR
   - configure the HMD by using the interactive cockpit display
   - Optional: configure your left and right MFD
4. Taxi to the runway
   - set flaps to full down
   - if present, retract the tailhook
   - start your main engine (we will use simple procedure, not advanced startup)
   - apply throttle at 2-5%, you will start rolling
   - when crossing runways look to the left and to the right
   - taxi to the beginning of your take-off runway
5. Make sure the runway is clear and no aircraft is currently preparing for takeoff or landing
   - Optional: announce your takeoff on this runway on airnet-2 to inform other pilots
   - in case of rodeo units in the area you must postpone take-off until rodeo has cleared the airspace completely

## Take Off

- After taxing to the beginning of the runway, align yourself parallel to the edges.
  - Make sure you have deployed max flaps, to have more lift and stability.
- Set your throttle to maximum, at around 300 km/h start pulling the nose up to 10 degrees, as soon as you are airborne you will raise the gear and bring the flaps up, then begin to climb up to the cruising altitude for that mission.
  - The F/A-18 has an onboard indicator, showing you when you are stalling, use it to see when you can pull up.

## Landing

- Align with the runway in front of you, reduce speed to around 400, deploy max flaps and set the gear down (activate tailhook for carrier landing).
- Reduce throttle and use the speed brake so that you will touch down on the runway at around 300 km/h, try to follow the middle of the runway as straight as possible, do not apply speed brakes at the moment of touching down. Do not touch the ground with your nose wheel first, keep the plane even and balanced with the nose slightly pointing upwards, slightly losing speed and altitude but not stalling, this will make the back wheels touch the ground first and then gently proceed to point your nose down to the runway, you can now start applying the full speed brake and your throttle to zero. If you feel like you can't make a safe landing, abort immediately: increase throttle and fly around for a second pass, YOU must be confident in YOUR landing.

When landing on a carrier remember it has a height of 35 meters so make sure you fly at around 40-45 meters when touching down. Also make sure you do not undershoot.

## Recon

- When you fly at your cruising altitude use the targeting camera and area lock feature (ctrl+m2 and ctrl+t) to spot and identify enemy forces in the AO. Try to reduce speed and maintain a stable throttle while you circle around. Do not reduce altitude or deviate from your circling pattern, stay at a minimum altitude of 2000 meters and keep a high distance to the area of operations and other aircraft, including friendly helicopters and supply drops.
  - Using the targeting camera you will be able to see the grid number of your target, you now have to use landmarks near the target to find and mark the enemy asset on your map.
  - Mark small ground units like infantry and jeeps in the Side channel with EI; bunkers will be marked as BNK, armoured vehicle with their name and a unique number(e.g. MBT 3).
  - Remember to always keep an eye on your heading, speed and altitude.
  - Leave the area if threats become imminent (enemy aircraft or SAM activity).

## AA Avoidance

There are 2 types of AA missile locking mechanisms that are modelled in Arma:

- **Fox 2**
  - Fox 2 is an infrared guided missile, which means it can lock on to nearby heat signatures (the target can be invisible to your radar, and you will still get a lock), the target will not receive a warning about the infrared lock on.
  - It has a 180 degree firing angle (you can fire it in tight turns and without having a direct view of the target, only using the lock on), but it has a maximum range of 5 km from where you can get a lock (e.g. BIM-9X, ASRAAM).
- **Fox 3**
  - Fox 3 is a radar semi-guided missile, that means it needs an active radar lock to engage, typically fired from BVR (beyond visual range), it gives a lock-on warning to the target and has a tight firing angle.
  - Many SPAAG (self-propelled anti-aircraft gun) have a small range, if you make an effort to stay at a minimum of 4 km away from these vehicles they will not be effective against you.

When entering combat zones stay at high speed to keep the vulnerability time window small.

### Surface-to-Air-Missile avoidance

- If you are engaged by a SAM, you have to use CM (countermeasures, which come as both flares and chaff) and immediately turn 90 degrees from the incoming missile direction, you want to use flares every 1-3 second (depending on the range from where the missile was launched) up to 5 times to reduce the probability of a missile hitting you.
  - Optional: set one of your radars to 2km or 4km.
  - This way you will be able to switch to it to better identify incoming missiles and once they come closer jerk your aircraft and use countermeasures to have the best chance of evading the missile.

After disengaging you can then turn on GPS again (or use the microDAGR all the time).

If you are hit but still able to stir the aircraft toward your closest base, let FAC know that you are disengaging and returning to base to repair. If you can't maneuver the aircraft, call mayday three times on the radio and eject by double pressing v. In case you manage to land inside the AO, you will have to be rescued by friendly ground units. Once you get back to platoons position you are free to recall yourself to base. If you drop outside the AO just recall yourself directly back to base.

## Communication

- The weapon systems of your aircraft can only be useful under three conditions:
  - your ability to communicate effectively with the forward air controller
  - your ability to follow the rules of engagement for the current mission
  - your ability to proactively avoid friendly fire incidents and danger to friendly units
- Effectiveness of a jet is based on how well it can communicate and relay data with the FAC. SL,PL or FAC will request close-air-support for a target, optionally provide a bearing and map marker and the best ingress and egress. Additional information will pertain to friendly units in the area and terrain surrounding the target as well as possible cover the target may be hiding in.
- FAC can laser designate targets for the pilot, also he will be able to abort a fire mission. The pilot is responsible for the aircraft and the weapon system. This means that the pilot has the last word (and full responsibility) about entering the AO, attacking the target and releasing the respective payload. This also means that in the case of a friendly fire incident the FAC will not be solely responsible but also the pilot will have to face the consequences.
- SL (squad lead) can request strikes directly to the pilot by radioing him via the 152 and providing direction information, as well as a marker on the map. He can also smoke his position to help the pilot in identifying foe from friendly.
  - Additional information that can increase the effectiveness of a strike consist of: elevation, landmarks, state of the target ( moving/stationary).
  - If the pilot is not comfortable with the task (not good enough info, friendlies closer the 100 meters) he might decide not to engage and inform the FAC/SL.
  - The pilot should keep an eye on the amount and type of weaponry he has left and decide ahead of an assaults if he should return and rearm.
  - The pilot will let the FAC know if he decides to return to base, he can also consider feedback from the FAC about staying in the AO longer.

<!-- -->

- When entering the AO it is required for the Pilot to inform the FAC:
  1. You: FAC, this is Whiskey-1.
  2. FAC: Whiskey-1, send for FAC.
  3. You: FAC, whiskey-1 is on station.
  4. FAC: FAC copies.
- If the pilot has uncovered potential ground targets during reconnaissance, marked them on the map and relayed this information to the FAC, but did not receive a CAS support request for a longer period of time while being present in the AO, it is recommended for the pilot to contact the FAC and refresh the information about the ground targets that can be attacked.
  - However, a pilot must never decide to engage a target on his own.
  - Exceptions are jets, helicopters and AA which pose a direct threat to the safety of the pilot, he should nonetheless inform ground assets he is engaging them.
  - He can engage any of them freely and can disregard any other task until he feels safe enough or the threats have been dealt with. If FAC/PL informs the pilot to avoid engaging those targets because ground assets might be able to do it then the pilot will simply avoid the dangerous area and wait for clearance from the FAC to return.
- Remember that once these threats have been dealt with, their wreck and following ammo explosions represent a danger to infantry. Make an effort to engage when friendlies are a safe distance away.

### Terms the pilot and FAC should know

- Bugout - out of fuel or ordnance, must go back to base
- Spike - indicates radar warning receiver threat
- Bogey - unknown radar contact
- Bandit - aircraft identified as enemy
- Bingo - low fuel, minimum amount to return to base
- RTB - Return To Base
- On station/off station - in/out of the AO
- Splash + number - expected time of impact
- Effect on target - request for result of mission or task
- Wilco - will comply
- Paveway - release of laser guided bomb
- Rifle - release of anti ground missile
- Breaking off - leaving an engagement

## When and how to offer support

- When the pilot has all the data he needs to carry out a CAS request, he must make a mental line from the closest friendly forces to the target and a line from his position to the target. As a general rule these 2 lines must be as perpendicular as possible to avoid any damage that a late or early drop might cause.
- If the pilot engages a target from long range, the person who called the strike will relay the BDA( Battle damage assessment). The pilot can request a BDA report by radioing “effect on target”.
- When approaching a ground target radar locks are the recommended procedure for locking on, they are more precise, provide more information about the target and will allow greater distances for the missiles to acquire the target and lock on. If using bombs lase the target and drop the bomb when you have the lock-on marker. In case of unguided bombs make sure you are properly on the target before releasing.
  - When locking onto a target the pilot will be notified of the lock audibly and with a visual marker over the target.
  - If there is an X over the target marker you must under no circumstances release the payload.

An X inside the target lock for a plane or a ground asset marks a FRIENDLY unit.

- When using laser locking it is recommended for the pilot to not use his own laser to ‘double lase' the target, if the FAC has already done it. If the FAC can't maintain a lock he will inform the pilot to switch to his own laser.
  - Handing over targets by switching lasers will obviously result in loss of the lock and the intended payload might miss a moving target as a result. Talk to FAC and let him know what method you want to use to engage the target (your laser or his).
- For example, the FAC can lase a priority target among a group of enemy vehicles, the pilot will then use his HMD to look for that particular laser icon, bring his targeting camera in this position, find the laser marker of the FAC, begin to shine his own laser on this mark and tell the FAC to turn off his own laser. Then the pilot can begin the approach and start locking on.

## Weapon Systems

The following weapon systems are working (at the moment of writing this document), and should be employed based on their type, range, and mode with which it acquires targets:

- **AGM-114N** type: thermobaric, targeting: laser, range: UNK
- **AGM-114L** type: HEAT, targeting: radar, range: 8km, notes: LOBL
- **AGM-114K** type: HEAT, targeting: laser, range: 8km, notes: LOBL, less precise
- **AGM-65L** type: HEAT, targeting: radar, range: 6km, notes: LOAL,only one of the 2 function
- **AGM-65G** type: HEAT, targeting: ir, range: 4km, notes: target needs to be hot
- **GBU 12** type: LGB, targeting: laser/unguided, range: UNK
- **GBU SDB** type: PGGB, targeting: laser/ir/unguided, range: UNK
- **CBU-85** type: cluster bomb, targeting: laser/unguided, range: UNK, notes: only for infantry
- **AGM-88C** type: ARM,targeting: enemy radar, range: 25 km, notes: only for SPAAG
- **Hydra 70** type: unguided rocket, targeting: HUD indicator, range: depends on the angle of attack, max 2km
- **AIM-120A** type: fox3, targeting: radar lock, range: 10km
- **AMRAAM D** type: fox3, targeting: radar lock, range: 12km
- **BIM-9X** type: fox2, targeting: IR, range: 2km, notes: 4km range with active radar
- **AIM-132** type: fox2, targeting: IR, range: 0.5km, notes: 5km range with active radar

---

ARM-anti radiation missile; LGB-laser guided bomb; PGGB-precision guided glide bomb

- LOBL (lock on before launch) missiles needs the target info from the onboard equipment and the targeting can be done only before firing.
- LOAL (lock on after launch) missiles can achieve a lock after they have left the aircraft, this can be done with the aid of radar or the internal guidance system.

<!-- -->

- There will be up to two loadouts available for the mission-makers to use for their missions:
  - Heavy focus on unguided bombs and unguided rockets, great effectiveness against infantry and static emplacements, with moderate capabilities against armoured targets.
    - Intended loadout: 2x1 Hydra 70 (12 rockets); 2x2 CBU-85; 2x1 Fuel Tank; 2x1 GBU 12; 4x1 GBU SDB
  - Focus on self-defense and surgical removing of enemy armour, less impact on enemy soft targets.
    - Intended loadout: 2x1 AMRAAM D; 2x1 AGM-65L; 2x1 AGM-65G; 2x1 GBU 12; 1x1 AGM-88C
  - Each loadout contains 2 BIM-9X missiles for close air-to-air combat survivability.
