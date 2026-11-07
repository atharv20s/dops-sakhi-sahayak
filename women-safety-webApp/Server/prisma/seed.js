// ==============================================================================
//  Sakhi Sahayak — Prisma Seed Script for PostgreSQL
// ==============================================================================
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // 1. Seed Police Stations from safety_data.json
  const safetyDataPath = path.join(__dirname, '..', 'safety_data.json');
  if (fs.existsSync(safetyDataPath)) {
    const safetyData = JSON.parse(fs.readFileSync(safetyDataPath, 'utf8'));
    const stations = safetyData.police_stations || [];
    console.log(`📍 Ingesting ${stations.length} police stations...`);

    let stationCount = 0;
    for (const station of stations) {
      const phoneArray = station.contact ? [station.contact] : [];
      // Use name + coordinates as unique logical identifier for upsert/find
      const existing = await prisma.policeStation.findFirst({
        where: {
          name: station.name,
          lat: station.lat,
          lng: station.lng
        }
      });

      if (!existing) {
        await prisma.policeStation.create({
          data: {
            name: station.name,
            lat: station.lat,
            lng: station.lng,
            phone: phoneArray,
            email: station.email || '',
            description: station.description || '',
            category: 'station',
            type: 'city'
          }
        });
        stationCount++;
      }
    }
    console.log(`✅ Seeded ${stationCount} new police stations.`);
  }

  // 2. Seed Legacy Safety Reports from safety_reports.json
  const reportsPath = path.join(__dirname, '..', 'safety_reports.json');
  if (fs.existsSync(reportsPath)) {
    const reportsData = JSON.parse(fs.readFileSync(reportsPath, 'utf8'));
    const reports = reportsData.reports || [];
    console.log(`📋 Ingesting ${reports.length} legacy safety reports...`);

    let reportCount = 0;
    for (const report of reports) {
      const isExact = report.exact === true;
      await prisma.safetyReport.upsert({
        where: { id: report.id },
        update: {
          category: report.category,
          locality: report.locality,
          description: report.description,
          lat: isExact ? report.lat : null,
          lng: isExact ? report.lng : null,
          shareExact: isExact
        },
        create: {
          id: report.id,
          category: report.category,
          locality: report.locality,
          description: report.description,
          lat: isExact ? report.lat : null,
          lng: isExact ? report.lng : null,
          shareExact: isExact,
          createdAt: report.createdAt ? new Date(report.createdAt) : new Date()
        }
      });
      reportCount++;
    }
    console.log(`✅ Seeded/Upserted ${reportCount} legacy safety reports.`);
  }

  console.log('🎉 Database seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
