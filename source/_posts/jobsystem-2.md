---
title: 手把手完成JobSystem-Part2定制内存分配器
date: 2024-09-02 19:54:32
tags:
---

## Job System 2.0: Lock-Free Work Stealing – Part 2: A specialized allocator

本文翻译自1，部分模块添加自己的理解，有兴趣的同学建议阅读原文。

本文讨论在job system中申请job时如何摆脱new和delete，内存申请可以使用更有效率的方式，但需要牺牲一些额外内存。结果得到的提升是巨大的，明显是值得的。

## 为什么使用new和delete很慢
如上文所说，new在本质上是调用allocator。通用的allocator需要考虑小块、中块、大块内存分配；还需要保证线程安全，内部使用同步语法/锁等方式避免数据竞争。

因此，我们额外做一个allocator会比默认的new delete快很多。即便通用内存分配器进行大量的优化也无法在特定分配上优于特定的allocator。

另外一点，使用new的方式需要手动去调用delete，因此做了延迟delete，并且在finish()中添加了原子计数器。

## 分配池？
job system只分配job，使用分配池/释放列表(pool allocator/free list)2看起来完美适配这个需求。使用无锁的分配池能够提升性能，但是仍然无法解决延迟delete的问题。

## 定制化Allocator
一件很重要的事情是：job system每帧在不停的做重复的事情。生产N个job，在一帧结束是再全部删掉。

可以通过预分配job实例避免整体分配和删除。因为job是POD类型struct，我们无需担心创建和销毁开销。我们可以一次性在job system创建时申请足够多的job（比如4096），把这个数组当做环状buffer提供给需要的地方，在shut down时释放整个数组。

所以我们要做的是全局的job数组和一个原子计数器，Allocate()函数如下：

```
static Job g_jobAllocator[MAX_JOB_COUNT];
static uint32_t g_allocatedJobs = 0u;

Job* AllocateJob(void)
{
  const uint32_t index = atomic::Increment(&g_allocatedJobs);
  return &g_jobAllocator[(index-1) % MAX_JOB_COUNT];
}
```

取余操作(index-1)%MAX_JOB_COUNT可以替换为二进制与操作，只要MAX_JOB_COUNT是2的次方，例如4096。

```
return &g_jobAllocator[(index-1u) & (MAX_JOB_COUNT-1u)];
```

可以看到，原子计数器是一个单调递增，永不重置的整数。所以我们在访问g_jobAllocator数组时通过取模操作很效率的编程循环队列。这样我们可以不必要在一帧的结束释放job，Finish()函数变为：

```
void Finish(Job* job) 
{
  const int32_t unfinsihedJobs = atomic::Decrement(&job->unfinishedJobs);
  if ((unfinishedJobs == 0) && (job->parent))
  {
    Finsih(job->parent);
  }
}
```

这样提前申请内存的方式需要4096 * 64 = 256KB内存空间，开销可以接受。

## 线程独占
对比使用一个原子操作，我们如何才能在预申请上做的更好？那就是一个都不用，原子操作比锁一类操作要廉价很多，但并不是没有开销。

通过把计数器和预分配的job数组改为线程独占，不在需要任何原子操作：

```
Job* AllocateJob(void)
{
  const uint32_t index = g_allocatedJobs++;
  return &g_jobAllocator[index & (MAX_JOB_COUNT - 1u)];
}
```

上述代码中，g_allocatedJobs和g_jobAllocator都是线程独占局部变量，不存在任何原子/锁操作。

对比之前版本的内存占用，如果有8个工作线程，内存增长从256KB到2MB，依然是一个很小的开销。

## 展望
下片文章，我们会处理job system的核心问题：实现一个无锁的偷取工作队列。

## 参考
[1] https://blog.molecular-matters.com/2015/09/08/job-system-2-0-lock-free-work-stealing-part-2-a-specialized-allocator/

[2] https://blog.molecular-matters.com/2012/09/17/memory-allocation-strategies-a-pool-allocator/

[3] https://fgiesen.wordpress.com/2014/08/18/atomics-and-contention/