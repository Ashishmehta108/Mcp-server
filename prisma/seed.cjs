const { PrismaClient } = require('@prisma/client');
const products = require('./products.json');
const prisma = new PrismaClient();
let i = 0;

async function main() {
  for (const product of products) {
    await prisma.product.create({
      data: product,
    });
    i++;
  }
}
main()
  .then(async () => {
    console.log("added seed data of webapp ✅" + "total products uploaded are : ", i)
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });