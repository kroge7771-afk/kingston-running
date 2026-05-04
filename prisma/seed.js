const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  await prisma.profile.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      name: "Kingston",
      dateOfBirth: new Date("2006-10-10"),
      heightCm: 174,
      stravaConnected: false,
    },
  });

  await prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      activePlan: "half",
      planStartDate: new Date("2026-05-03"),
      halfCompleted: false,
      comfortableDistKm: 5.0,
    },
  });

  console.log("Seed complete — Kingston's profile and settings initialised.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
