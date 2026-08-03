const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;
const app = express();
// stripe
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");

function generateTrackingId() {
  const prefix = "TRK";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomString = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${randomString}`;
}

// middleware
app.use(cors());
app.use(express.json());

// mongodb
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.jd5uu0i.mongodb.net/?appName=Cluster0`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const database = client.db("zap_shift_db");
const parcelCollections = database.collection("parcels");
const paymentCollections = database.collection("payments");

client
  .connect()
  .then(() => {
    console.log("ZapShift server side connected to MongoDB");
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err);
  });

app.get("/", (req, res) => {
  res.send("ZapShift server is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "ZapShift API is running",
  });
});

app.get("/parcels", async (req, res) => {
  try {
    const query = {};
    const { email } = req.query;
    if (email) {
      query.senderEmail = email;
    }

    const options = { sort: { createdAt: -1 } };
    const cursor = parcelCollections.find(query, options);
    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.get("/parcels/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };

    const result = await parcelCollections.findOne(query);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.post("/parcels", async (req, res) => {
  try {
    const parcel = req.body;
    parcel.createdAt = new Date();

    const result = await parcelCollections.insertOne(parcel);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

// Payment Api
app.post("/payment-checkout-session", async (req, res) => {
  try {
    const paymentInfo = req.body;
    const amount = parseInt(paymentInfo.cost) * 100;

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "USD",
            unit_amount: amount,
            product_data: {
              name: paymentInfo.parcelName,
            },
          },
          quantity: 1,
        },
      ],
      customer_email: paymentInfo.senderEmail,
      mode: "payment",
      metadata: {
        parcelId: paymentInfo.parcelId,
        parcelName: paymentInfo.parcelName,
      },
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });
    // console.log(session);
    res.send({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

// old
app.post("/create-checkout-session", async (req, res) => {
  try {
    const paymentInfo = req.body;
    const amount = parseInt(paymentInfo.cost) * 100;

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "USD",
            unit_amount: amount,
            product_data: {
              name: paymentInfo.parcelName,
            },
          },
          quantity: 1,
        },
      ],
      customer_email: paymentInfo.senderEmail,
      mode: "payment",
      metadata: {
        parcelId: paymentInfo.parcelId,
      },
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });
    console.log(session);
    res.send({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});


app.patch("/payment-success", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === "paid") {
      const id = session.metadata.parcelId;
      const query = { _id: new ObjectId(id) };

      // Check if this payment record already exists to prevent duplicates
      const existingPayment = await paymentCollections.findOne({
        sessionId: session.id,
      });

      let resultPayment = existingPayment;
      let result = null; // Declare result beforehand
      let trackingId;

      if (!existingPayment) {
        trackingId = generateTrackingId();

        // 1. Update parcel status and payment info only if not already processed
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "Ready for Pickup",
            transactionId: session.payment_intent,
            trackingId: trackingId,
            paidAt: new Date(),
          },
        };

        result = await parcelCollections.updateOne(query, update);

        // 2. Insert payment record once
        const paymentRecord = {
          parcelId: session.metadata.parcelId,
          transactionId: session.payment_intent,
          sessionId: session.id,
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail:
            session.customer_details?.email || session.customer_email,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
        };

        resultPayment = await paymentCollections.insertOne(paymentRecord);
      } else {
        // If it already exists, fetch the existing trackingId from the parcel if needed
        const parcel = await parcelCollections.findOne(query);
        trackingId = parcel?.trackingId;
      }

      return res.send({
        success: true,
        message: existingPayment
          ? "Payment already processed"
          : "Payment processed successfully",
        modifyParcel: result,
        trackingId: trackingId,
        transactionId: session.payment_intent,  
        paymentInfo: resultPayment,
      });
    }

    res.send({ success: false, message: "Payment not completed" });
  } catch (error) {
    console.error("Payment success route error:", error);
    res.status(500).send({ message: error.message });
  }
});

app.delete("/parcels/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };

    const result = await parcelCollections.deleteOne(query);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.listen(port, () => {
  console.log(`ZapShift app listening on port ${port}`);
});
