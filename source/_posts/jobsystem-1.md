---
title: 手把手完成JobSystem-Part1基础
date: 2024-09-02 19:47:23
tags:
---

## Job System 2.0: Lock-Free Work Stealing – Part 1: Basics

本文翻译自1，部分模块添加自己的理解，有兴趣的同学建议阅读原文。Job System要求：
1. 基本实现原理要足够简单，jobs本身应该足够“愚蠢”，基于此上层能够抽象更高层次用法，例如：parallel_for  Job System需要自动负载均衡  
2. 尽可能多的模块实现无锁方案，提升性能表现  
3. 系统需要能够支持“动态并行”：在job执行过程中能够更改父子关系并且为其添加依赖。这一点允许高级抽象parallel_for能够动态拆分jobs

本文将使用locks/临界代码实现一个Job System的基本版本，即使使用locks，依然有很多陷阱问题需要在无锁编程之前说明。

## 基本概念
Job System基本运行机制如下：  N个工作线程持续的从队列中获取job并执行  N个物理核心，创建N-1个工作线程 * 主线程也是工作线程，能够帮助执行job。

这次的job system主要基于两个观点： 
1. 应用Work stealing的概念，表示并不是所有的线程从一个全局job queue中获取job，而是每一个work thread都拥有一个job queue。
2. 全局job queue在多线程下会有争抢问题，工作窃取简单有效。

* 新工作被放入calling thread的job queue
* 当一个work thread想要执行时，先从自己的queue中pop，如果没有，尝试从其他thread中窃取。
* Push和Pop只被拥有当前queue的线程调用
* Steal被不拥有这个queue的线程调用

根据最后两项可以得出以下结论：
1. Push和Pop在queue的一端（private端）工作，steal在queue的另一端（public端）工作。
2. private端LIFO工作，更好利用cache；public端FIFO平衡工作。

在work stealing中，这种双端数据结构被称为work-stealing queue/deque，最大的优势在于这种数据结构让无锁结构成为可能。示例代码如下：
```
// main function of each worker thread
while (workerThreadActive)
{
  Job* job = GetJob();
  if (job)
  {
    Execute(job);
  }
}
Job* GetJob(void)
{
  WorkStealingQueue* queue = GetWorkerThreadQueue();

  Job* job = queue->Pop();
  if (IsEmptyJob(job))
  {
    // this is not a valid job because our own queue is empty, so try stealing from some other queue
    unsigned int randomIndex = GenerateRandomNumber(0, g_workerThreadCount+1);
    WorkStealingQueue* stealQueue = g_jobQueues[randomIndex];
    if (stealQueue == queue)
    {
      // don"t try to steal from ourselves
      Yield();
      return nullptr;
    }

    Job* stolenJob = stealQueue->Steal();
    if (IsEmptyJob(stolenJob))
    {
      // we couldn"t steal a job from the other queue either, so we just yield our time slice for now
      Yield();
      return nullptr;
    }

    return stolenJob;
  }

  return job;
}

void Execute(Job* job)
{
  (job->function)(job, job->data);
  Finish(job);
}
```
实现中忽略了Finish方法，后续进行补全。

## 什么是Job
遵循“尽可能简单”的原则，job需要保存两个东西：需要被执行的函数指针、可选的父job。 另外还需要保存未完成的job数量来维护job的父子关系；维护padding保证一个job占据至少一个cache line，避免False Sharing。

```
struct Job
{
  JobFunction function;
  Job* parent;
  int32_t unfinishedJobs; // atomic
  char padding[];
};
```

unfinishedJobs成员必须是atomic类型；padding没有填入具体数据，因为32-bit和64bit会有所不同，需要sizeof填充。一个job函数有两个成员：所属的job和job所关联的data。

```
typedef void (*JobFunction)(Job*, const void*);
```

## 关联数据与job
旧版本task scheduler中，用户需要持有job数据直到job执行完毕，当数据储存在栈中的时候没有问题， 但是在堆上的时候往往需要额外的内存申请。现在解决方案：在job数据结构中储存data。

padding数组很适合储存job data，反正要占据空间，并且不使用。通过编译期检查，data copy进入padding数组。如果数据过大，用户可以再堆上申请内存，只把数据指针传递给job system。

## 添加job
添加job分为两步：1. 创建一个job；2. 添加job到system中。分为两步有助于我们动态并行（前文提到的特征）。

```
Job* CreateJob(JobFunction function)
{
  Job* job = AllocateJob();
  job->function = function;
  job->parent = nullptr;
  job->unfinishedJobs = 1;

  return job;
}

Job* CreateJobAsChild(Job* parent, JobFunction function)
{
  atomic::Increment(&parent->unfinishedJobs);

  Job* job = AllocateJob();
  job->function = function;
  job->parent = parent;
  job->unfinishedJobs = 1;

  return job;
}
```

注意这里省略了需要copy到padding数组中的job数据。当创建一个已存在job的子job时，parent的unfinishedJobs需要原子化自增，因为其他线程可能也在add job，造成数据竞争。

添加刚创建的job到system队列中，调用Run():

```
void Run(Job* job)
{
  WorkStealingQueue* queue = GetWorkerThreadQueue();
  queue->Push(job);
}
```

## 等待job

当然，当添加了一些job，需要能够检查job是否完成，于此同时执行一些其他事件；需要调用Wait():

```
void Wait(const Job* job)
{
  // wait until the job has completed. in the meantime, work on any other job.
  while (!HasJobCompleted(job))
  {
    Job* nextJob = GetJob();
    if (nextJob)
    {
      Execute(nextJob);
    }
  }
}
```

决定一个job是否完成的依据是比较unfinishedJobs和0，如果>0，job自己或者child job依然有未执行完成的；如果=0，所有的相关job都已完成。

## 实践
下面的例子创建了一些空job添加进系统。

```
void empty_job(Job*, const void*)
{
}

for (unsigned int i=0; i < N; ++i)
{
  Job* job = jobSystem::CreateJob(&empty_job);
  jobSystem::Run(job);
  jobSystem::Wait(job);
}
```

当然这里的线程模型并不好，每创建一个job都去执行、并且等待job完成，是一个创建、添加、执行的测试用例。

另外一个例子是，创建empty job，但是都作为一个父job的子job来执行：

```
Job* root = jobSystem::CreateJob(&empty_job);
for (unsigned int i=0; i < N; ++i)
{
  Job* job = jobSystem::CreateJobAsChild(root, &empty_job);
  jobSystem::Run(job);
}
jobSystem::Run(root);
jobSystem::Wait(root);
```

这次更加高效，执行job是并行化执行。

## 结束并且删除job
我们需要在结束是告诉父job执行结束，然后释放申请的job。需要设计Finish：

```
void Finish(Job* job)
{
  const int32_t unfinishedJobs = atomic::Decrement(&job->unfinishedJobs);
  if (unfinishedJobs == 0)
  {
    if (job->parent)
    {
      Finish(job->parent);
    }

    delete job;
  }
}
```

首先原子级别自减unfinishedJobs计数器，当计数器为0时，代表当前job所有子job都已经完成，所以需要告知父job。另外，我们可以删除当前job，这里存在一个bug，能不能看出来呢？

问题在于不允许在此时删除job，可能有其他线程在调用waiting，等待这个job完成，此时析构，会导致无效指针问题。一种解决方案是延迟删除的时间节点，仍然需要认真考虑：

```
void Finish(Job* job)
{
  const int32_t unfinishedJobs = atomic::Decrement(&job->unfinishedJobs);
  if (unfinishedJobs == 0)
  {
    const int32_t index = atomic::Increment(&g_jobToDeleteCount);
    g_jobsToDelete[index-1] = job;

    if (job->parent)
    {
      Finish(job->parent);
    }
  }
}
```

在全局array中保存需要被删除的job，但仍然存在问题。原因是：一旦线程完成了unfinishedJobs自减(上述代码第3行)，线程就会被抢占。（这里还有疑问？？）如果不幸这个job刚好是root job，在此时会删除所有job会导致灾难性后果。

当然有线程安全的办法：

```
void Finish(Job* job)
{
  const int32_t unfinishedJobs = atomic::Decrement(&job->unfinishedJobs);
  if (unfinishedJobs == 0)
  {
    const int32_t index = atomic::Increment(&g_jobToDeleteCount);
    g_jobsToDelete[index-1] = job;

    if (job->parent)
    {
      Finish(job->parent);
    }

    atomic::Decrement(&job->unfinishedJobs);
  }
}
```

在job被添加到全局删除队列中后，并且父job被明确已经finish后，再次自减1。此时，完成的任务unfinishedJobs数值为-1，而不是0。在root job执行完成后，可以安全的删除所有job。

在这个场景下，unfinishedJobs可以不用原子操作自减，但是代码需要特定的内存顺序才能够保证正确。

## 实现细节
可以使用_mm_pause/sleep()或者其他变量产生线程时间片。然而需要保证worker thread不会再空闲时百分百占据CPU。事件、信号量、条件变量可以用于空闲线程。

## 展望
下篇文章会讨论删除new和delete，简化finish()。之后讨论如何无锁实现窃取队列。

## 声明
文章假定x86体系结构和强大的内存模型。如果您不了解底层含义，那么在其他平台上工作时，最好使用具有顺序一致性的C ++ 11和std::atomic。

## 参考
[1] https://blog.molecular-matters.com/2015/08/24/job-system-2-0-lock-free-work-stealing-part-1-basics/

[2] https://en.wikipedia.org/wiki/Work_stealing

[3] https://blog.molecular-matters.com/2012/04/25/building-a-load-balanced-task-scheduler-part-3-parent-child-relationships/

[4] https://blog.molecular-matters.com/2012/07/09/building-a-load-balanced-task-scheduler-part-4-false-sharing/