const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;
const app = express();
// stripe
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

try {
  const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
    "utf8",
  );
  const serviceAccount = JSON.parse(decoded);

  initializeApp({
    credential: cert(serviceAccount),
  });
  console.log("Firebase initialized");
} catch (err) {
  console.error(err);
}

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
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const database = client.db("zap_shift_db");
const userCollections = database.collection("users");
const parcelCollections = database.collection("parcels");
const paymentCollections = database.collection("payments");
const riderCollections = database.collection("riders");
const trackingCollections = database.collection("trackings");

let cachedClient = null;

async function connectToDatabase() {
  if (cachedClient) {
    return cachedClient;
  }
  await client.connect();
  cachedClient = client;
  return cachedClient;
}

//Jwt middleware
const verifyFirebaseToken = async (req, res, next) => {
  try {
    await connectToDatabase();
    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith("Bearer ")) {
      return res
        .status(401)
        .send({ message: "Unauthorized Access: No token provided" });
    }

    const token = authorization.split(" ")[1];

    const decoded = await getAuth().verifyIdToken(token);
    req.token_email = decoded.email;
    next();
  } catch (err) {
    console.error("Token verification error:", err.message);
    return res.status(401).send({
      message: "Invalid token",
      error: err.message,
    });
  }
};

app.get("/", (req, res) => {
  res.send("ZapShift server is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "ZapShift API is running",
  });
});

// Admin middleware - must be used after verifyFirebaseToken
const verifyAdmin = async (req, res, next) => {
  await connectToDatabase();
  const email = req.token_email;
  const query = { email };
  const user = await userCollections.findOne(query);

  if (!user || user.role !== "admin") {
    return res.status(403).send({ message: "Forbidden Access" });
  }

  next();
};

// Rider middleware - must be used after verifyFirebaseToken
const verifyRider = async (req, res, next) => {
  await connectToDatabase();
  const email = req.token_email;
  const query = { email };
  const user = await userCollections.findOne(query);

  if (!user || user.role !== "rider") {
    return res.status(403).send({ message: "Forbidden Access" });
  }

  next();
};

const logTracking = async (trackingId, status) => {
  await connectToDatabase();
  const log = {
    trackingId,
    status,
    details: status.split("-").join(" "),
    createdAt: new Date(),
  };
  const result = await trackingCollections.insertOne(log);
  return result;
};

// users related api
app.post("/users", async (req, res) => {
  try {
    await connectToDatabase();
    const user = req.body;
    user.role = "user";
    user.createdAt = new Date();
    const email = user.email;
    const existingUser = await userCollections.findOne({ email });

    if (existingUser) {
      return res.send({ message: "User already exists" });
    }

    const result = await userCollections.insertOne(user);
    res.send(user);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.get("/users", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    await connectToDatabase();
    const searchText = req.query.searchText;

    if (searchText && typeof searchText !== "string") {
      return res.status(400).send({
        message: "Invalid search text",
      });
    }

    const query = {};

    if (searchText) {
      const safeSearchText = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      query.$or = [
        {
          displayName: {
            $regex: safeSearchText,
            $options: "i",
          },
        },
        {
          email: {
            $regex: safeSearchText,
            $options: "i",
          },
        },
      ];
    }

    const result = await userCollections
      .find(query)
      .sort({ createdAt: -1 })
      .limit(7)
      .toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: error.message,
    });
  }
});

app.get("/users/:email/role", async (req, res) => {
  try {
    await connectToDatabase();
    const email = req.params.email;
    const query = { email };
    const user = await userCollections.findOne(query);
    res.send({ role: user?.role || "user" });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.patch(
  "/users/:id/role",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {
    try {
      await connectToDatabase();
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          ...roleInfo,
        },
      };
      const result = await userCollections.updateOne(query, updateDoc);

      res.send(result);
    } catch (error) {
      console.error(error);
      res.status(500).send({
        message: error.message,
      });
    }
  },
);

// Parcels Api
app.get("/parcels", async (req, res) => {
  try {
    await connectToDatabase();
    const query = {};
    const { email, deliveryStatus } = req.query;

    if (email) {
      query.senderEmail = email;
    }

    if (deliveryStatus) {
      const statuses = deliveryStatus.split(",");
      query.deliveryStatus = {
        $in: statuses,
      };
    }

    const result = await parcelCollections
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: error.message,
    });
  }
});

app.get(
  "/parcels/rider",
  verifyFirebaseToken,
  verifyRider,
  async (req, res) => {
    try {
      await connectToDatabase();
      const { riderEmail, deliveryStatus } = req.query;

      if (!riderEmail) {
        return res.status(400).send({ message: "riderEmail is required" });
      }

      const query = {
        riderEmail: riderEmail,
      };

      if (deliveryStatus) {
        const statuses = deliveryStatus.split(",");
        query.deliveryStatus = {
          $in: statuses,
        };
      }

      const result = await parcelCollections
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    } catch (error) {
      console.error(error);
      res.status(500).send({
        message: error.message,
      });
    }
  },
);

app.get("/parcels/:id", async (req, res) => {
  try {
    await connectToDatabase();
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };

    const result = await parcelCollections.findOne(query);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.get("/parcels/delivery-status/stats", async (req, res) => {
  try {
    await connectToDatabase();
    const pipeLine = [
      {
        $group: {
          _id: "$deliveryStatus",
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          status: "$_id",
          count: 1,
        },
      },
    ];
    const result = await parcelCollections.aggregate(pipeLine).toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.post("/parcels", async (req, res) => {
  try {
    await connectToDatabase();
    const parcel = req.body;
    const trackingId = generateTrackingId();

    parcel.createdAt = new Date();
    parcel.trackingId = trackingId;

    await logTracking(trackingId, "parcel-create");

    const result = await parcelCollections.insertOne(parcel);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.patch(
  "/parcels/:id",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {
    try {
      await connectToDatabase();
      const { riderId, riderName, riderContact, riderEmail, trackingId } =
        req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          deliveryStatus: "driver-assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
          riderContact: riderContact,
        },
      };

      const result = await parcelCollections.updateOne(query, updateDoc);

      const riderQuery = { _id: new ObjectId(riderId) };
      const updatedRiderDoc = {
        $set: {
          workStatus: "in-transit",
        },
      };

      await riderCollections.updateOne(riderQuery, updatedRiderDoc);

      await logTracking(trackingId, "driver-assigned");

      res.send(result);
    } catch (error) {
      console.error(error);
      res.status(500).send({ message: error.message });
    }
  },
);

app.patch(
  "/parcels/:id/status",
  verifyFirebaseToken,
  verifyRider,
  async (req, res) => {
    try {
      await connectToDatabase();
      const { deliveryStatus, riderEmail, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      let updateDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };

      if (deliveryStatus === "driver-rejected" && riderEmail) {
        updateDoc = {
          $set: {
            deliveryStatus: "driver-rejected",
            riderId: null,
            riderName: null,
            riderEmail: null,
            riderContact: null,
          },
          $push: { rejectedRiders: riderEmail },
        };
      }

      const result = await parcelCollections.updateOne(query, updateDoc);

      if (deliveryStatus === "parcel-delivered" && riderEmail) {
        await riderCollections.updateOne(
          { email: riderEmail },
          { $set: { workStatus: "available" } },
        );
      }

      await logTracking(trackingId, deliveryStatus);

      res.send(result);
    } catch (error) {
      console.error(error);
      res.status(500).send({ message: error.message });
    }
  },
);

app.delete("/parcels/:id", verifyFirebaseToken, async (req, res) => {
  try {
    await connectToDatabase();
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };

    const result = await parcelCollections.deleteOne(query);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

// Payment API
app.post("/payment-checkout-session", async (req, res) => {
  try {
    const parcelInfo = req.body;
    const amount = parseInt(parcelInfo.cost) * 100;

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "USD",
            unit_amount: amount,
            product_data: {
              name: `Please pay for ${parcelInfo.parcelName}`,
            },
          },
          quantity: 1,
        },
      ],
      customer_email: parcelInfo.senderEmail,
      mode: "payment",
      metadata: {
        parcelId: parcelInfo.parcelId,
        parcelName: parcelInfo.parcelName,
        trackingId: parcelInfo.trackingId,
      },
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });
    res.send({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.patch("/payment-success", async (req, res) => {
  try {
    await connectToDatabase();
    const sessionId = req.query.session_id;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === "paid") {
      const id = session.metadata.parcelId;
      const query = { _id: new ObjectId(id) };

      const existingPayment = await paymentCollections.findOne({
        sessionId: session.id,
      });

      let resultPayment = existingPayment;
      let result = null;
      let trackingId;

      if (!existingPayment) {
        trackingId = session.metadata.trackingId;

        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "ready-for-pickup",
            transactionId: session.payment_intent,
            trackingId: trackingId,
            paidAt: new Date(),
          },
        };

        result = await parcelCollections.updateOne(query, update);

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

        await logTracking(trackingId, "ready-for-pickup");
      } else {
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

    return res.send({ success: false, message: "Payment not completed" });
  } catch (error) {
    console.error("Payment success route error:", error);
    res.status(500).send({ message: error.message });
  }
});

app.get("/payments", verifyFirebaseToken, async (req, res) => {
  try {
    await connectToDatabase();
    const email = req.token_email;

    const result = await paymentCollections
      .aggregate([
        {
          $match: {
            customerEmail: email,
          },
        },
        {
          $addFields: {
            parcelObjectId: {
              $toObjectId: "$parcelId",
            },
          },
        },
        {
          $lookup: {
            from: "parcels",
            localField: "parcelObjectId",
            foreignField: "_id",
            as: "parcel",
          },
        },
        {
          $unwind: "$parcel",
        },
        {
          $sort: { paidAt: -1 },
        },
      ])
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// Riders related apis
app.get("/riders", async (req, res) => {
  try {
    await connectToDatabase();
    const { status, district, workStatus } = req.query;
    const query = {};

    if (status) {
      query.status = status;
    }
    if (district) {
      query.district = district;
    }
    if (workStatus) {
      query.workStatus = workStatus;
    }

    const cursor = riderCollections.find(query);
    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.get("/riders/delivery-per-day", async (req, res) => {
  try {
    await connectToDatabase();
    const email = req.query.email;
    const pipeLine = [
      {
        $match: {
          riderEmail: email,
          deliveryStatus: "parcel-delivered",
        },
      },
      {
        $lookup: {
          from: "trackings",
          localField: "trackingId",
          foreignField: "trackingId",
          as: "parcelTrackings",
        },
      },
      {
        $unwind: "$parcelTrackings",
      },
      {
        $match: {
          "parcelTrackings.status": "parcel-delivered",
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$parcelTrackings.createdAt",
            },
          },
          count: { $sum: 1 },
        },
      },
    ];
    const result = await parcelCollections.aggregate(pipeLine).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.post("/riders", async (req, res) => {
  try {
    await connectToDatabase();
    const rider = req.body;

    const existingRider = await riderCollections.findOne({
      email: rider.email,
    });

    if (existingRider) {
      return res.status(409).send({
        message: "Rider application already exists for this email.",
        insertedId: null,
      });
    }

    rider.status = "pending";
    rider.createdAt = new Date();

    const result = await riderCollections.insertOne(rider);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.patch("/riders/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    await connectToDatabase();
    const id = req.params.id;
    const { status } = req.body;

    const rider = await riderCollections.findOne({
      _id: new ObjectId(id),
    });

    if (!rider) {
      return res.status(404).send({
        message: "Rider not found",
      });
    }

    const updateDoc = {
      $set: {
        status,
      },
    };

    if (status === "approved") {
      updateDoc.$set.workStatus = "available";

      await userCollections.updateOne(
        { email: rider.email },
        {
          $set: {
            role: "rider",
          },
        },
      );
    }

    const result = await riderCollections.updateOne(
      { _id: new ObjectId(id) },
      updateDoc,
    );

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: error.message,
    });
  }
});

app.delete(
  "/riders/:id",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {
    try {
      await connectToDatabase();
      const id = req.params.id;
      const email = req.query.email;

      if (email !== req.token_email) {
        return res.status(403).send({ message: "Forbidden access" });
      }

      const query = { _id: new ObjectId(id) };
      const result = await riderCollections.deleteOne(query);
      res.send(result);
    } catch (error) {
      console.error(error);
      res.status(500).send({ message: error.message });
    }
  },
);

// Tracking related APIs
app.get("/trackings/:trackingId/logs", async (req, res) => {
  try {
    await connectToDatabase();
    const trackingId = req.params.trackingId;
    const query = { trackingId };
    const result = await trackingCollections.find(query).toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = app;
